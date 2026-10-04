// The Lambda entry point must turn function-URL events into parsed JSON bodies
// (serverless-http + Express 5 otherwise drop them).
import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
let handler;

before(async () => {
  process.env.MCP_SERVICE_TOKEN = 'lambda-token';
  process.env.OPENAI_API_KEY = 'sk-test';
  ({ handler } = await import('../lambda.js'));
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function invoke(body, { token = 'lambda-token', type = 'application/json' } = {}) {
  return handler({
    version: '2.0',
    rawPath: '/api/assistant/chat',
    rawQueryString: '',
    headers: { 'content-type': type, 'x-mcp-service-token': token },
    requestContext: { http: { method: 'POST', path: '/api/assistant/chat', sourceIp: '192.0.2.1' } },
    body: Buffer.from(body).toString('base64'),
    isBase64Encoded: true,
  }, {});
}

const question = JSON.stringify({ messages: [{ role: 'user', content: 'Which licenses can be reclaimed?' }] });

test('function URL JSON bodies reach the chat route', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: 'From the model' }), { status: 200 });
  for (const type of ['application/json', 'application/json; charset=utf-8']) {
    const response = await invoke(question, { type });
    assert.equal(response.statusCode, 200, type);
    assert.equal(JSON.parse(response.body).answer, 'From the model');
  }
});

test('invalid, oversized and non-JSON bodies are rejected', async () => {
  const oversized = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(70 * 1024) }] });
  for (const [body, type] of [['{not json', 'application/json'], [oversized, 'application/json'], [question, 'text/plain']]) {
    assert.equal((await invoke(body, { type })).statusCode, 400);
  }
});

test('the service token is still required', async () => {
  assert.equal((await invoke(question, { token: 'wrong' })).statusCode, 401);
});
