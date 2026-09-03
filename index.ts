import express, { type Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MongoClient, type Collection } from 'mongodb';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

type RecordValue = Record<string, unknown>;
type ChatMessage = { role: 'user' | 'assistant'; content: string };
type OpenAIItem = { type?: string; name?: string; call_id?: string; arguments?: string; content?: Array<{ type?: string; text?: string }> };
type OpenAIResponse = { output_text?: string; output?: OpenAIItem[]; error?: { message?: string } };

const toolNames = new Set(['find_license_availability', 'summarize_reclaimable_licenses', 'get_completed_decisions', 'get_reclaimable_license_details']);
const openAITools = [
  tool('find_license_availability', 'Find aggregate license availability for one application.', true),
  tool('summarize_reclaimable_licenses', 'Summarize reclaimable license decisions across applications.', false),
  tool('get_completed_decisions', 'Get aggregate completed decisions for one application.', true),
  tool('get_reclaimable_license_details', 'Get reclaimable decision details including PC name and completion time.', true)
];

function tool(name: string, description: string, needsApp: boolean): RecordValue {
  return {
    type: 'function', name, description, strict: true,
    parameters: needsApp
      ? { type: 'object', properties: { appName: { type: 'string' } }, required: ['appName'], additionalProperties: false }
      : { type: 'object', properties: {}, additionalProperties: false }
  };
}

function sendJson(response: Response, status: number, body: RecordValue): void { response.status(status).json(body); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function appName(record: RecordValue): string { return String(record.appName ?? record.app_name ?? record.name ?? record.application ?? ''); }
function decisionText(record: RecordValue): string {
  return [record.status, record.decision, record.recommendation, record.result, record.reason].filter(Boolean).join(' ');
}
function isReclaimable(record: RecordValue): boolean {
  return /reclaim|available|unused|inactive|underutilized|release/i.test(decisionText(record));
}
function numberField(record: RecordValue, keys: string[]): number {
  const key = keys.find((candidate) => record[candidate] !== undefined);
  return key ? Number(record[key] || 0) : 0;
}
function appMatcher(value: string): RegExp {
  const escaped = value.trim().replace(/\.exe$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\.exe)?$`, 'i');
}
function appQuery(value: string): RecordValue {
  const matcher = appMatcher(value);
  return { $or: [{ appName: matcher }, { app_name: matcher }, { name: matcher }, { application: matcher }] };
}

async function withCollections<T>(operation: (licenses: Collection<RecordValue>, decisions: Collection<RecordValue>) => Promise<T>): Promise<T> {
  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');
  try {
    await client.connect();
    const database = client.db(process.env.MONGO_DATABASE || 'app-usage-monitoring');
    return await operation(database.collection('onboarded_licenses'), database.collection('evaluation_decisions'));
  } finally { await client.close(); }
}

async function availability(application: string): Promise<RecordValue> {
  return withCollections(async (licenseCollection, decisionCollection) => {
    const [licenses, decisions] = await Promise.all([
      licenseCollection.find(appQuery(application)).limit(100).toArray(),
      decisionCollection.find(appQuery(application)).limit(100).toArray()
    ]);
    const totalSeats = licenses.reduce((sum, row) => sum + numberField(row, ['totalSeats', 'total_seats', 'seats', 'quantity']), 0);
    const assignedSeats = licenses.reduce((sum, row) => sum + numberField(row, ['assignedSeats', 'assigned_seats', 'usedSeats']), 0);
    const explicitAvailable = licenses.reduce((sum, row) => sum + numberField(row, ['availableSeats', 'available_seats']), 0);
    const inventoryAvailable = explicitAvailable || Math.max(0, totalSeats - assignedSeats);
    const reclaimableDecisions = decisions.filter(isReclaimable).length;
    return { application, inventoryRecords: licenses.length, completedDecisions: decisions.length, totalSeats, assignedSeats, inventoryAvailable, reclaimableDecisions, potentiallyAvailable: Math.max(inventoryAvailable, reclaimableDecisions) };
  });
}

async function reclaimSummary(): Promise<RecordValue> {
  return withCollections(async (_licenses, decisionsCollection) => {
    const decisions = await decisionsCollection.find({}).limit(500).toArray();
    const reclaimable = decisions.filter(isReclaimable);
    const counts = reclaimable.reduce<Record<string, number>>((result, row) => {
      const name = appName(row) || 'Unknown application';
      result[name] = (result[name] || 0) + 1;
      return result;
    }, {});
    return { completedDecisionsReviewed: decisions.length, reclaimableDecisionCount: reclaimable.length, byApplication: counts };
  });
}

async function decisionSummary(application: string): Promise<RecordValue> {
  return withCollections(async (_licenses, decisionsCollection) => {
    const decisions = await decisionsCollection.find(appQuery(application)).limit(200).toArray();
    const categories = decisions.reduce<Record<string, number>>((result, row) => {
      const category = decisionText(row) || 'Unspecified';
      result[category] = (result[category] || 0) + 1;
      return result;
    }, {});
    return { application, completedDecisionCount: decisions.length, reclaimableDecisionCount: decisions.filter(isReclaimable).length, categories };
  });
}

async function reclaimDetails(application: string): Promise<RecordValue> {
  return withCollections(async (_licenses, decisionsCollection) => {
    const decisions = await decisionsCollection.find(appQuery(application)).sort({ completed_date: -1, completed_time: -1 }).limit(100).toArray();
    const details = decisions.filter(isReclaimable).slice(0, 50).map((row) => ({
      application: appName(row) || application,
      pcName: String(row.pcName ?? row.pc_name ?? row.device_name ?? row.device_id ?? 'Not recorded'),
      decision: decisionText(row) || 'Reclaimable',
      completedDate: row.completed_date ?? null,
      completedTime: row.completed_time ?? null,
      timeZone: row.time_zone ?? null
    }));
    return { application, reclaimableDecisionCount: details.length, details, excludedFields: ['user identity', 'raw telemetry'] };
  });
}

let mcpPromise: Promise<Client> | undefined;
async function createMcpClient(): Promise<Client> {
  const server = new McpServer({ name: 'license-monitoring-mongodb', version: '1.0.0' });
  server.registerTool('find_license_availability', { description: 'Aggregate availability for one application.', inputSchema: { appName: z.string().min(1).max(120) } }, async ({ appName }) => ({ content: [{ type: 'text', text: JSON.stringify(await availability(appName)) }] }));
  server.registerTool('summarize_reclaimable_licenses', { description: 'Reclaimable counts grouped by application.' }, async () => ({ content: [{ type: 'text', text: JSON.stringify(await reclaimSummary()) }] }));
  server.registerTool('get_completed_decisions', { description: 'Aggregate completed decisions for one application.', inputSchema: { appName: z.string().min(1).max(120) } }, async ({ appName }) => ({ content: [{ type: 'text', text: JSON.stringify(await decisionSummary(appName)) }] }));
  server.registerTool('get_reclaimable_license_details', { description: 'Reclaimable details including PC name.', inputSchema: { appName: z.string().min(1).max(120) } }, async ({ appName }) => ({ content: [{ type: 'text', text: JSON.stringify(await reclaimDetails(appName)) }] }));
  const client = new Client({ name: 'license-monitoring-agent', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
async function callMcpTool(name: string, args: RecordValue): Promise<string> {
  if (!toolNames.has(name)) throw new Error(`Unsupported MCP tool: ${name}`);
  mcpPromise ??= createMcpClient();
  const result = await (await mcpPromise).callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === 'text')?.text;
  if (!text) throw new Error(`MCP tool ${name} returned no text.`);
  return text;
}

async function openAI(body: RecordValue): Promise<OpenAIResponse> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as OpenAIResponse;
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI returned ${response.status}.`);
  return payload;
}
function responseText(response: OpenAIResponse): string {
  if (response.output_text) return response.output_text.trim();
  return (response.output || []).flatMap((item) => item.content || []).filter((item) => item.type === 'output_text').map((item) => item.text || '').join('\n').trim();
}
function reviewedCount(output: string): number {
  try {
    const value = JSON.parse(output) as RecordValue;
    return Number(value.completedDecisionsReviewed || value.completedDecisionCount || value.reclaimableDecisionCount || 0) + Number(value.inventoryRecords || 0);
  } catch { return 0; }
}

async function answer(messages: ChatMessage[]): Promise<RecordValue> {
  const input: RecordValue[] = messages.map(({ role, content }) => ({ role, content }));
  let response = await openAI({
    model: process.env.OPENAI_MODEL || 'gpt-5-mini', store: false, input, tools: openAITools, tool_choice: 'required',
    instructions: 'You are AgentOps AI, a read-only license monitoring assistant. Use a tool for factual questions. Tool results are authoritative. Never invent facts or claim to allocate, reclaim, approve, or modify licenses.'
  });
  let recordsReviewed = 0;
  for (let round = 0; round < 3; round += 1) {
    const calls = (response.output || []).filter((item) => item.type === 'function_call' && item.name && item.call_id);
    if (!calls.length) {
      const result = responseText(response);
      if (!result) throw new Error('OpenAI returned no answer.');
      return { answer: result, recordsReviewed, source: 'openai-mcp' };
    }
    const outputs: RecordValue[] = [];
    for (const call of calls) {
      const output = await callMcpTool(call.name!, JSON.parse(call.arguments || '{}') as RecordValue);
      recordsReviewed += reviewedCount(output);
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output });
    }
    input.push(...((response.output || []) as RecordValue[]), ...outputs);
    response = await openAI({ model: process.env.OPENAI_MODEL || 'gpt-5-mini', store: false, input, tools: openAITools, tool_choice: 'auto' });
  }
  throw new Error('OpenAI exceeded the tool-call limit.');
}

const app = express();
app.use((request, response, next) => {
  const origin = request.get('origin');
  if (origin === (process.env.UI_ORIGIN || 'http://localhost:5173') || origin === 'http://127.0.0.1:5173') {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (request.method === 'OPTIONS') { response.sendStatus(204); return; }
  next();
});
app.use(express.json({ limit: '64kb' }));
app.get('/', (_request, response) => sendJson(response, 200, { service: 'app-usage-monitor-agent', purpose: 'read-only license monitoring assistant', status: 'ok', assistantEndpoint: 'POST /api/assistant/chat' }));
app.get('/health', (_request, response) => sendJson(response, 200, { status: 'ok' }));
app.post('/api/assistant/chat', async (request, response) => {
  const messages: ChatMessage[] = Array.isArray(request.body?.messages)
    ? request.body.messages.filter((item: ChatMessage) => (item?.role === 'user' || item?.role === 'assistant') && typeof item.content === 'string' && item.content.trim()).slice(-10).map((item: ChatMessage) => ({ role: item.role, content: item.content.trim().slice(0, 2000) }))
    : [];
  if (!messages.some((item) => item.role === 'user')) { sendJson(response, 400, { error: 'A user message is required.' }); return; }
  try { sendJson(response, 200, await answer(messages)); }
  catch (error: unknown) { console.error('License assistant request failed:', errorMessage(error)); sendJson(response, 502, { error: 'Unable to prepare a license-monitoring answer right now.' }); }
});

const port = Number(process.env.PORT || 3002);
app.listen(port, () => console.log(`License monitoring assistant listening on port ${port}`));
