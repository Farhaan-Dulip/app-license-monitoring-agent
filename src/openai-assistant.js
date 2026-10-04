import { callMcpTool, openAITools } from './mcp-tools.js';
const INSTRUCTIONS = 'You are AgentOps AI, a read-only license monitoring assistant. Use a tool for factual questions. Tool results are authoritative. If a tool returns an error, say the data was unavailable rather than guessing. Never invent facts or claim to allocate, reclaim, approve, or modify licenses.';
// Whole-request budget; kept below the portal's ASSISTANT_AGENT_TIMEOUT_MS (25 s).
function deadlineMs() {
    return Number(process.env.AGENT_DEADLINE_MS) || 20000;
}
async function createResponse(body, signal) {
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
            instructions: INSTRUCTIONS,
            tools: openAITools,
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
export async function answerLicenseQuestion(messages) {
    const signal = AbortSignal.timeout(deadlineMs());
    const input = messages.map(({ role, content }) => ({ role, content }));
    let response = await createResponse({ input, tool_choice: 'required' }, signal);
    let recordsReviewed = 0;
    for (let round = 0; round < 3; round += 1) {
        const calls = (response.output || []).filter((item) => item.type === 'function_call' && item.name && item.call_id);
        if (!calls.length) {
            const answer = responseText(response);
            if (!answer)
                throw new Error('OpenAI returned no answer.');
            return { answer, recordsReviewed, source: 'openai-mcp' };
        }
        const outputs = [];
        for (const call of calls) {
            signal.throwIfAborted();
            const args = parseArguments(call.arguments);
            const output = args
                ? await callMcpTool(call.name, args)
                : JSON.stringify({ error: 'Tool arguments were not valid JSON.' });
            recordsReviewed += reviewedCount(output);
            outputs.push({ type: 'function_call_output', call_id: call.call_id, output });
        }
        input.push(...(response.output || []), ...outputs);
        response = await createResponse({ input, tool_choice: 'auto' }, signal);
    }
    throw new Error('OpenAI exceeded the tool-call limit.');
}
