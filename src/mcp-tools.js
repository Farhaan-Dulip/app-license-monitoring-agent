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
// Portal failures (network, auth, 5xx) mean the agent cannot answer from data;
// they abort the request so the portal falls back to its database answer.
// Model mistakes (bad arguments, unknown tools) are returned to the model instead.
const PORTAL_UNAVAILABLE = 'PORTAL_UNAVAILABLE';
export class ToolUnavailableError extends Error {
}
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
        signal: AbortSignal.timeout(Number(process.env.PORTAL_TOOL_TIMEOUT_MS) || 8000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(String(payload.error || `Portal MCP endpoint returned ${response.status}.`));
    return payload;
}
async function portalTool(path, appName) {
    try {
        return { content: [{ type: 'text', text: JSON.stringify(await callPortalMcp(path, appName)) }] };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `${PORTAL_UNAVAILABLE}: ${message}` }], isError: true };
    }
}
async function createMcpClient() {
    const server = new McpServer({ name: 'license-monitoring-portal-tools', version: '1.0.0' });
    server.registerTool('find_license_availability', { description: 'Aggregate availability for one application.', inputSchema: { appName: z.string().min(1).max(120) } }, ({ appName }) => portalTool('/api/mcp/license-availability', appName));
    server.registerTool('summarize_reclaimable_licenses', { description: 'Reclaimable counts grouped by application.' }, () => portalTool('/api/mcp/reclaimable-summary'));
    server.registerTool('get_completed_decisions', { description: 'Aggregate completed decisions for one application.', inputSchema: { appName: z.string().min(1).max(120) } }, ({ appName }) => portalTool('/api/mcp/decision-summary', appName));
    server.registerTool('get_reclaimable_license_details', { description: 'Reclaimable details including PC name.', inputSchema: { appName: z.string().min(1).max(120) } }, ({ appName }) => portalTool('/api/mcp/reclaimable-details', appName));
    const client = new Client({ name: 'license-monitoring-agent', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
}
// Returns the tool output for the model. Unknown tools and invalid arguments are
// reported back to the model as JSON errors; portal outages throw.
export async function callMcpTool(name, args) {
    if (!toolNames.has(name))
        return JSON.stringify({ error: `Unknown tool: ${name}. Use only the listed tools.` });
    mcpClientPromise ??= createMcpClient();
    const result = await (await mcpClientPromise).callTool({ name, arguments: args });
    const text = result.content.find((item) => item.type === 'text')?.text;
    if (result.isError) {
        if (text?.startsWith(PORTAL_UNAVAILABLE))
            throw new ToolUnavailableError(`MCP tool ${name} failed: ${text}`);
        return JSON.stringify({ error: text || `Tool ${name} rejected the request.` });
    }
    if (!text)
        throw new ToolUnavailableError(`MCP tool ${name} returned no text.`);
    return text;
}
