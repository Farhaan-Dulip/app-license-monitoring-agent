import { callMcpTool, openAITools, raiseLicenseRequest, raiseLicenseRequestTool } from './mcp-tools.js';
const INSTRUCTIONS = 'You are AgentOps AI, a license monitoring assistant. Use a tool for factual questions. Tool results are authoritative. If a tool returns an error, say the data was unavailable rather than guessing. Never invent facts or claim to allocate, reclaim, approve, or modify licenses. Do not offer actions you have no tool for, such as notifying people or assigning licenses.';
const REQUEST_INSTRUCTIONS = ' When the person asks for a license, seat or access to an application for themselves, call raise_license_request once. Afterwards tell them who approves it (the app owner from the tool result) and that no license is assigned until it is approved. If the tool reports a pending duplicate, say a request is already waiting. Do not raise requests for questions about licenses or for other people.';
const NO_REQUESTER_INSTRUCTIONS = ' You cannot raise license requests in this conversation: if the person asks for a license or access, tell them to enter their name and work email in the chat panel and ask again.';
// Whole-request budget; kept below the portal's ASSISTANT_AGENT_TIMEOUT_MS (25 s).
function deadlineMs() {
    return Number(process.env.AGENT_DEADLINE_MS) || 20000;
}
async function createResponse(body, signal, context) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey)
        throw new Error('OPENAI_API_KEY is not configured.');
    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: process.env.OPENAI_MODEL || 'gpt-5-mini',
            store: false,
            // With store=false, reasoning items can only be replayed in later turns
            // when their encrypted content is returned with them.
            include: ['reasoning.encrypted_content'],
            instructions: INSTRUCTIONS + (context.requester ? REQUEST_INSTRUCTIONS : NO_REQUESTER_INSTRUCTIONS),
            tools: context.requester ? [...openAITools, raiseLicenseRequestTool] : openAITools,
            ...body
        }),
        signal
    });
    const payload = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new Error(payload.error?.message || `OpenAI returned ${response.status}.`);
    return payload;
}
function responseText(response) {
    if (response.output_text)
        return response.output_text.trim();
    return (response.output || [])
        .flatMap((item) => item.content || [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text || '')
        .join('\n')
        .trim();
}
function reviewedCount(output) {
    try {
        const value = JSON.parse(output);
        return Number(value.completedDecisionsReviewed || value.completedDecisionCount || value.reclaimableDecisionCount || 0) + Number(value.inventoryRecords || 0);
    }
    catch {
        return 0;
    }
}
function parseArguments(raw) {
    try {
        const value = JSON.parse(raw || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
export async function answerLicenseQuestion(messages, context = {}) {
    const signal = AbortSignal.timeout(deadlineMs());
    const input = messages.map(({ role, content }) => ({ role, content }));
    let response = await createResponse({ input, tool_choice: 'required' }, signal, context);
    let recordsReviewed = 0;
    // At most one request per turn, however often the model calls the tool.
    let raised;
    for (let round = 0; round < 3; round += 1) {
        const calls = (response.output || []).filter((item) => item.type === 'function_call' && item.name && item.call_id);
        if (!calls.length) {
            const answer = responseText(response);
            if (!answer)
                throw new Error('OpenAI returned no answer.');
            return { answer, recordsReviewed, source: 'openai-mcp', ...(raised?.request ? { workflow: raised.request } : {}) };
        }
        const outputs = [];
        for (const call of calls) {
            signal.throwIfAborted();
            const args = parseArguments(call.arguments);
            let output;
            if (!args) {
                output = JSON.stringify({ error: 'Tool arguments were not valid JSON.' });
            }
            else if (call.name === raiseLicenseRequestTool.name && context.requester) {
                raised ??= await raiseLicenseRequest(args, context);
                output = raised.output;
            }
            else {
                output = await callMcpTool(call.name, args);
            }
            recordsReviewed += reviewedCount(output);
            outputs.push({ type: 'function_call_output', call_id: call.call_id, output });
        }
        input.push(...(response.output || []), ...outputs);
        response = await createResponse({ input, tool_choice: 'auto' }, signal, context);
    }
    throw new Error('OpenAI exceeded the tool-call limit.');
}
