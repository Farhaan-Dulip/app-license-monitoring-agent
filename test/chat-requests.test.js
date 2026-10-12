import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { answerLicenseQuestion } from '../src/openai-assistant.js';

const realFetch = globalThis.fetch;
const requester = { name: 'Farhan', email: 'farhan@example.com' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function raiseCall(callId = 'call-1', appName = 'Postman') {
  return { type: 'function_call', name: 'raise_license_request', call_id: callId, arguments: JSON.stringify({ appName, reason: 'API testing' }) };
}

// OpenAI replies come from `openaiReplies` in order; portal POSTs go to `portal`.
function mockFetch({ openaiReplies, portal }) {
  const calls = { openai: [], portal: [] };
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith('https://api.openai.com/')) {
      calls.openai.push(JSON.parse(init.body));
      return json(openaiReplies.shift() ?? { output_text: 'done' });
    }
    if (href.endsWith('/api/mcp/license-requests')) {
      const body = JSON.parse(init.body);
      calls.portal.push(body);
      return portal(body);
    }
    throw new Error(`unexpected ${href}`);
  };
  return calls;
}

const created = (body) => json({
  request: { id: 'req-9', requestedApp: 'Postman', approvingManagerName: 'Nadia Perera', status: 'pending_approval' },
  duplicate: false,
}, 201);

beforeEach(() => {
  process.env.MCP_SERVICE_TOKEN = 'token';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.PORTAL_API_URL = 'http://portal.test';
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('raises the request for the portal-supplied requester and returns the workflow', async () => {
  const calls = mockFetch({
    openaiReplies: [{ output: [raiseCall()] }, { output_text: 'Sent to Nadia Perera for approval.' }],
    portal: created,
  });
  const result = await answerLicenseQuestion(
    [{ role: 'user', content: 'can you sort me out with postman' }],
    { requester, clientId: 'browser-1' }
  );
  assert.deepEqual(calls.portal, [{
    requestedApp: 'Postman',
    reason: 'API testing',
    requesterName: 'Farhan',
    requesterEmail: 'farhan@example.com',
    clientId: 'browser-1',
    source: 'chat',
  }]);
  assert.equal(result.workflow.id, 'req-9');
  assert.equal(result.workflow.approvingManagerName, 'Nadia Perera');
  assert.equal(result.answer, 'Sent to Nadia Perera for approval.');
  assert.ok(calls.openai[0].tools.some((tool) => tool.name === 'raise_license_request'));
});

test('without a requester profile the tool is not offered', async () => {
  const calls = mockFetch({ openaiReplies: [{ output_text: 'Enter your name and work email first.' }], portal: created });
  const result = await answerLicenseQuestion([{ role: 'user', content: 'I need postman' }], {});
  assert.ok(!calls.openai[0].tools.some((tool) => tool.name === 'raise_license_request'));
  assert.match(calls.openai[0].instructions, /enter their name and work email/);
  assert.equal(result.workflow, undefined);
  assert.equal(calls.portal.length, 0);
});

test('repeated tool calls in one turn raise only one request', async () => {
  const calls = mockFetch({
    openaiReplies: [{ output: [raiseCall('a'), raiseCall('b')] }, { output: [raiseCall('c')] }, { output_text: 'Done.' }],
    portal: created,
  });
  await answerLicenseQuestion([{ role: 'user', content: 'Postman please' }], { requester });
  assert.equal(calls.portal.length, 1);
});

test('portal validation errors go back to the model, not the requester record', async () => {
  const calls = mockFetch({
    openaiReplies: [{ output: [raiseCall('a', 'Slack')] }, { output_text: 'Slack is not onboarded.' }],
    portal: () => json({ error: 'Slack is not an onboarded application.' }, 404),
  });
  const result = await answerLicenseQuestion([{ role: 'user', content: 'I need Slack' }], { requester });
  const toolOutput = calls.openai[1].input.find((item) => item.type === 'function_call_output');
  assert.match(toolOutput.output, /not an onboarded application/);
  assert.equal(result.workflow, undefined);
});
