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
export const raiseLicenseRequestTool = {
    type: 'function',
    name: 'raise_license_request',
    description: 'Raise a license request for the person you are chatting with, sent to the app owner for approval. ' +
        'Use only when they ask for a license, seat or access to an application for themselves.',
    strict: true,
    parameters: {
        type: 'object',
        properties: {
            appName: { type: 'string', description: 'Application name, e.g. Postman' },
            reason: { type: 'string', description: 'Why they need it, in their words; empty if not given' }
        },
        required: ['appName', 'reason'],
        additionalProperties: false
    }
};
// Creates the request on the portal for the context's requester. Validation
// failures (unknown app, no owner) are returned for the model to explain.
export async function raiseLicenseRequest(args, context) {
    if (!context.requester) {
        return { output: JSON.stringify({ error: 'The requester name and work email are not set in the chat panel.' }) };
    }
    const portalApiUrl = (process.env.PORTAL_API_URL || 'http://localhost:3000').replace(/\/$/, '');
    const serviceToken = process.env.MCP_SERVICE_TOKEN?.trim();
    if (!serviceToken)
        throw new ToolUnavailableError('MCP_SERVICE_TOKEN is not configured.');
    let response;
    try {
        response = await fetch(`${portalApiUrl}/api/mcp/license-requests`, {
            method: 'POST',
            headers: { 'X-MCP-Service-Token': serviceToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requestedApp: String(args.appName || '').slice(0, 120),
                reason: String(args.reason || '').slice(0, 1000),
                requesterName: context.requester.name,
                requesterEmail: context.requester.email,
                clientId: context.clientId || '',
                source: 'chat'
            }),
            signal: AbortSignal.timeout(Number(process.env.PORTAL_TOOL_TIMEOUT_MS) || 8000)
        });
    }
    catch (error) {
        throw new ToolUnavailableError(`raise_license_request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const payload = (await response.json().catch(() => ({})));
    if (response.status >= 500)
        throw new ToolUnavailableError(`raise_license_request failed: portal returned ${response.status}.`);
    if (!response.ok)
        return { output: JSON.stringify({ error: String(payload.error || 'The portal rejected the request.') }) };
    const raised = (payload.request || {});
    const request = {
        id: String(raised.id || ''),
        requestedApp: String(raised.requestedApp || ''),
        approvingManagerName: String(raised.approvingManagerName || ''),
        status: String(raised.status || ''),
        duplicate: Boolean(payload.duplicate)
    };
    return { output: JSON.stringify({ ...request, licenseAssigned: false }), request };
}
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
