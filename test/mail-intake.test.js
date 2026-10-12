import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MailIntake, checkSender, isAutomatedMessage, mailConfigFromEnv } from '../src/mail-intake.js';

const config = {
  tenantId: 'tenant',
  clientId: 'client',
  clientSecret: 'secret',
  mailbox: 'license-agent@example.com',
  allowedDomains: ['example.com'],
  pollMs: 30000,
  maxAttempts: 2,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function message(overrides = {}) {
  return {
    id: 'msg-1',
    internetMessageId: '<m1@example.com>',
    subject: 'Postman license',
    receivedDateTime: '2026-10-13T08:00:00Z',
    from: { emailAddress: { name: 'Farhan', address: 'Farhan@example.com' } },
    sender: { emailAddress: { name: 'Farhan', address: 'farhan@example.com' } },
    body: { contentType: 'text', content: 'Hi, I need a Postman license to test our APIs.' },
    internetMessageHeaders: [{ name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' }],
    ...overrides,
  };
}

// Fake Graph + OpenAI + portal. Records every call; `extraction` is what the model returns.
function harness({ messages = [message()], extraction, portalCreate } = {}) {
  const calls = { patch: [], reply: [], create: [], openai: [] };
  const fetch = async (url, init = {}) => {
    const href = String(url);
    const method = init.method || 'GET';
    if (href.startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'graph-token', expires_in: 3600 });
    if (href.startsWith('https://graph.microsoft.com/')) {
      assert.equal(init.headers.Authorization, 'Bearer graph-token');
      if (method === 'GET') return json({ value: messages });
      if (method === 'PATCH') { calls.patch.push(JSON.parse(init.body)); return json({}); }
      if (href.endsWith('/reply')) { calls.reply.push(JSON.parse(init.body).comment); return new Response(null, { status: 202 }); }
    }
    if (href.startsWith('https://api.openai.com/')) {
      calls.openai.push(JSON.parse(init.body));
      return json({ output_text: JSON.stringify(extraction ?? { isLicenseRequest: true, appName: 'Postman', reason: 'API testing.' }) });
    }
    if (href.endsWith('/api/mcp/onboarded-apps')) return json({ apps: ['Figma', 'Postman'] });
    if (href.endsWith('/api/mcp/license-requests')) {
      const body = JSON.parse(init.body);
      calls.create.push(body);
      return portalCreate ? portalCreate(body) : json({
        request: { id: 'req-1', requestedApp: body.requestedApp, approvingManagerName: 'Nadia Perera' },
        duplicate: false,
      }, 201);
    }
    throw new Error(`unexpected ${method} ${href}`);
  };
  return { calls, intake: new MailIntake(config, { fetch, log: () => {} }) };
}

beforeEach(() => {
  process.env.MCP_SERVICE_TOKEN = 'token';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.PORTAL_API_URL = 'http://portal.test';
});

test('config is off until all Graph settings exist; sender domain defaults to the mailbox domain', () => {
  assert.equal(mailConfigFromEnv({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' }), null);
  const parsed = mailConfigFromEnv({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_MAILBOX: 'Agent@Corp.com' });
  assert.equal(parsed.mailbox, 'agent@corp.com');
  assert.deepEqual(parsed.allowedDomains, ['corp.com']);
});

test('accepts internal or DMARC-authenticated senders from allowed domains only', () => {
  assert.equal(checkSender(message(), config).ok, true);
  assert.equal(checkSender(message({ internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=pass; dmarc=pass action=none' }] }), config).ok, true);
  const rejected = (overrides) => checkSender(message(overrides), config).ok;
  assert.equal(rejected({ internetMessageHeaders: [] }), false);
  assert.equal(rejected({ internetMessageHeaders: [{ name: 'Authentication-Results', value: 'dmarc=fail' }] }), false);
  assert.equal(rejected({ from: { emailAddress: { address: 'someone@evil.test' } }, sender: undefined }), false);
  assert.equal(rejected({ sender: { emailAddress: { address: 'delegate@example.com' } } }), false);
  assert.equal(rejected({ from: { emailAddress: { address: 'license-agent@example.com' } }, sender: undefined }), false);
});

test('detects automatic replies and bounces', () => {
  assert.ok(isAutomatedMessage(message({ internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }] })));
  assert.ok(isAutomatedMessage(message({ from: { emailAddress: { address: 'postmaster@example.com' } } })));
  assert.ok(!isAutomatedMessage(message()));
});

test('raises a request for the app owner and replies with the reference', async () => {
  const { calls, intake } = harness();
  await intake.pollOnce();
  assert.deepEqual(calls.create, [{
    requestedApp: 'Postman',
    requesterName: 'Farhan',
    requesterEmail: 'farhan@example.com',
    reason: 'API testing.',
    sourceMessageId: '<m1@example.com>',
  }]);
  assert.match(calls.reply[0], /Postman license request/);
  assert.match(calls.reply[0], /Approver: Nadia Perera \(app owner\)/);
  assert.match(calls.reply[0], /Reference: req-1/);
  assert.deepEqual(calls.patch, [{ isRead: true, categories: ['License agent: request raised'] }]);
  // The model may only choose an onboarded app.
  assert.deepEqual(calls.openai[0].text.format.schema.properties.appName.enum, ['Figma', 'Postman', 'NONE']);
});

test('a reprocessed email does not raise or reply twice', async () => {
  const { calls, intake } = harness({
    portalCreate: () => json({ request: { id: 'req-1', requestedApp: 'Postman' }, duplicate: true }),
  });
  await intake.pollOnce();
  assert.equal(calls.reply.length, 0);
  assert.equal(calls.patch[0].categories[0], 'License agent: request raised');
});

test('unknown apps get the list of onboarded apps; non-requests get guidance', async () => {
  let run = harness({ extraction: { isLicenseRequest: true, appName: 'NONE', reason: '' } });
  await run.intake.pollOnce();
  assert.equal(run.calls.create.length, 0);
  assert.match(run.calls.reply[0], /Figma, Postman/);
  assert.equal(run.calls.patch[0].categories[0], 'License agent: needs info');

  run = harness({ extraction: { isLicenseRequest: false, appName: 'NONE', reason: '' } });
  await run.intake.pollOnce();
  assert.equal(run.calls.create.length, 0);
  assert.equal(run.calls.patch[0].categories[0], 'License agent: not a request');
});

test('an app name outside the onboarded list is treated as unknown', async () => {
  const { calls, intake } = harness({ extraction: { isLicenseRequest: true, appName: 'Slack', reason: 'x' } });
  await intake.pollOnce();
  assert.equal(calls.create.length, 0);
  assert.equal(calls.patch[0].categories[0], 'License agent: needs info');
});

test('portal validation errors are explained to the sender', async () => {
  const { calls, intake } = harness({
    portalCreate: () => json({ error: 'No app owner is configured for Postman.' }, 409),
  });
  await intake.pollOnce();
  assert.match(calls.reply[0], /No app owner is configured for Postman/);
  assert.equal(calls.patch[0].categories[0], 'License agent: needs info');
});

test('unauthenticated senders are filed without a reply or a request', async () => {
  const { calls, intake } = harness({ messages: [message({ internetMessageHeaders: [] })] });
  await intake.pollOnce();
  assert.equal(calls.openai.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.reply.length, 0);
  assert.equal(calls.patch[0].categories[0], 'License agent: rejected sender');
});

test('portal outages leave the email unread for retry, then file it as failed', async () => {
  const { calls, intake } = harness({ portalCreate: () => json({ error: 'down' }, 503) });
  await intake.pollOnce();
  assert.equal(calls.patch.length, 0);
  await intake.pollOnce();
  assert.deepEqual(calls.patch, [{ isRead: true, categories: ['License agent: failed'] }]);
});
