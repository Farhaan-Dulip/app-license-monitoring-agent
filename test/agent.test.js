import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { callMcpTool, ToolUnavailableError } from '../src/mcp-tools.js';
import { answerLicenseQuestion } from '../src/openai-assistant.js';

const realFetch = globalThis.fetch;
const TOKEN = 'test-service-token';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Routes mocked fetch calls: OpenAI responses come from `openaiReplies` in order,
// portal MCP endpoints from `portal`.
function mockFetch({ openaiReplies = [], portal = () => json({ completedDecisionsReviewed: 3 }) } = {}) {
  const calls = { openai: [], portal: [] };
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith('https://api.openai.com/')) {
      calls.openai.push(JSON.parse(init.body));
      return json(openaiReplies.shift() ?? { output_text: 'done' });
    }
    if (href.includes('/api/mcp/')) {
      calls.portal.push({ url: href, headers: init.headers });
      return portal(href);
    }
    return realFetch(url, init);
  };
  return calls;
}

beforeEach(() => {
  process.env.MCP_SERVICE_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.PORTAL_API_URL = 'http://portal.test';
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function withServer(run) {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const chatBody = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

test('chat endpoint rejects missing or wrong service tokens', async () => {
  await withServer(async (base) => {
    const post = (headers) => realFetch(`${base}/api/assistant/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: chatBody,
    });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ 'X-MCP-Service-Token': 'wrong' })).status, 401);
    assert.equal((await realFetch(`${base}/health`)).status, 200);
  });
});

test('chat endpoint refuses requests when no token is configured', async () => {
  delete process.env.MCP_SERVICE_TOKEN;
  await withServer(async (base) => {
    const response = await realFetch(`${base}/api/assistant/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-Service-Token': 'x' }, body: chatBody,
    });
    assert.equal(response.status, 503);
  });
});

test('chat endpoint answers with a valid token', async () => {
  mockFetch({ openaiReplies: [{ output_text: 'Hello from the agent' }] });
  await withServer(async (base) => {
    const response = await realFetch(`${base}/api/assistant/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-Service-Token': TOKEN }, body: chatBody,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answer, 'Hello from the agent');
  });
});

test('unknown tools are reported to the model, not thrown', async () => {
  const output = JSON.parse(await callMcpTool('drop_database', {}));
  assert.match(output.error, /Unknown tool/);
});

test('invalid tool arguments are reported to the model, not thrown', async () => {
  const calls = mockFetch();
  const output = JSON.parse(await callMcpTool('find_license_availability', { appName: '' }));
  assert.ok(output.error);
  assert.equal(calls.portal.length, 0);
});

test('portal outages throw so the portal can fall back', async () => {
  mockFetch({ portal: () => json({ error: 'Unauthorized MCP service request' }, 401) });
  await assert.rejects(
    callMcpTool('summarize_reclaimable_licenses', {}),
    (error) => error instanceof ToolUnavailableError && /Unauthorized/.test(error.message)
  );
});

test('tool calls send the service token and app name to the portal', async () => {
  const calls = mockFetch({ portal: () => json({ application: 'Postman', inventoryRecords: 1 }) });
  const output = JSON.parse(await callMcpTool('find_license_availability', { appName: 'Postman' }));
  assert.equal(output.application, 'Postman');
  assert.equal(calls.portal[0].headers['X-MCP-Service-Token'], TOKEN);
  assert.match(calls.portal[0].url, /license-availability\?appName=Postman$/);
});

test('tool loop keeps instructions on every turn and returns the final answer', async () => {
  const calls = mockFetch({
    openaiReplies: [
      { output: [{ type: 'function_call', name: 'summarize_reclaimable_licenses', call_id: 'c1', arguments: '{}' }] },
      { output_text: 'There are 3 reclaimable licenses.' },
    ],
  });
  const result = await answerLicenseQuestion([{ role: 'user', content: 'What can be reclaimed?' }]);
  assert.equal(result.answer, 'There are 3 reclaimable licenses.');
  assert.equal(result.recordsReviewed, 3);
  assert.equal(calls.openai.length, 2);
  calls.openai.forEach((body) => {
    assert.match(body.instructions, /read-only/);
    assert.equal(body.store, false);
  });
  assert.equal(calls.openai[0].tool_choice, 'required');
  assert.equal(calls.openai[1].tool_choice, 'auto');
});

test('malformed tool arguments do not abort the conversation', async () => {
  const calls = mockFetch({
    openaiReplies: [
      { output: [{ type: 'function_call', name: 'find_license_availability', call_id: 'c1', arguments: '{not json' }] },
      { output_text: 'I could not read that request.' },
    ],
  });
  const result = await answerLicenseQuestion([{ role: 'user', content: 'Postman?' }]);
  assert.equal(result.answer, 'I could not read that request.');
  const toolOutput = calls.openai[1].input.find((item) => item.type === 'function_call_output');
  assert.match(toolOutput.output, /not valid JSON/);
});

test('overall deadline aborts slow requests', async () => {
  process.env.AGENT_DEADLINE_MS = '50';
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  try {
    await assert.rejects(answerLicenseQuestion([{ role: 'user', content: 'slow' }]));
  } finally {
    delete process.env.AGENT_DEADLINE_MS;
  }
});
