import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
const toolNames = new Set([
    'find_license_availability',
    'summarize_reclaimable_licenses',
    'get_completed_decisions',
    'get_reclaimable_license_details'
]);
function openAITool(name, description, needsApp) {
    return {
        type: 'function',
        name,
        description,
        strict: true,
        parameters: needsApp
            ? {
                type: 'object',
                properties: { appName: { type: 'string' } },
                required: ['appName'],
                additionalProperties: false
            }
            : { type: 'object', properties: {}, additionalProperties: false }
    };
}
export const openAITools = [
    openAITool('find_license_availability', 'Find aggregate license availability for one application.', true),
    openAITool('summarize_reclaimable_licenses', 'Summarize reclaimable license decisions across applications.', false),
    openAITool('get_completed_decisions', 'Get aggregate completed decisions for one application.', true),
    openAITool('get_reclaimable_license_details', 'Get reclaimable decision details including PC name and completion time.', true)
];
let mcpClientPromise;
async function callPortalMcp(path, appName) {
    const portalApiUrl = (process.env.PORTAL_API_URL || 'http://localhost:3000').replace(/\/$/, '');
    const serviceToken = process.env.MCP_SERVICE_TOKEN?.trim();
    if (!serviceToken)
        throw new Error('MCP_SERVICE_TOKEN is not configured.');
    const url = new URL(`${portalApiUrl}${path}`);
    if (appName)
        url.searchParams.set('appName', appName);
    const response = await fetch(url, {
        headers: { 'X-MCP-Service-Token': serviceToken },
        signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(String(payload.error || `Portal MCP endpoint returned ${response.status}.`));
    return payload;
}
async function createMcpClient() {
    const server = new McpServer({ name: 'license-monitoring-portal-tools', version: '1.0.0' });
    server.registerTool('find_license_availability', { description: 'Aggregate availability for one application.', inputSchema: { appName: z.string().min(1).max(120) } }, async ({ appName }) => ({ content: [{ type: 'text', text: JSON.stringify(await callPortalMcp('/api/mcp/license-availability', appName)) }] }));
    server.registerTool('summarize_reclaimable_licenses', { description: 'Reclaimable counts grouped by application.' }, async () => ({ content: [{ type: 'text', text: JSON.stringify(await callPortalMcp('/api/mcp/reclaimable-summary')) }] }));
    server.registerTool('get_completed_decisions', { description: 'Aggregate completed decisions for one application.', inputSchema: { appName: z.string().min(1).max(120) } }, async ({ appName }) => ({ content: [{ type: 'text', text: JSON.stringify(await callPortalMcp('/api/mcp/decision-summary', appName)) }] }));
    server.registerTool('get_reclaimable_license_details', { description: 'Reclaimable details including PC name.', inputSchema: { appName: z.string().min(1).max(120) } }, async ({ appName }) => ({ content: [{ type: 'text', text: JSON.stringify(await callPortalMcp('/api/mcp/reclaimable-details', appName)) }] }));
    const client = new Client({ name: 'license-monitoring-agent', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
}
export async function callMcpTool(name, args) {
    if (!toolNames.has(name))
        throw new Error(`Unsupported MCP tool: ${name}`);
    mcpClientPromise ??= createMcpClient();
    const result = await (await mcpClientPromise).callTool({ name, arguments: args });
    const text = result.content.find((item) => item.type === 'text')?.text;
    if (!text)
        throw new Error(`MCP tool ${name} returned no text.`);
    return text;
}
