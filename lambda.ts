// AWS Lambda entry point for the pay-per-use deployment. Loads secrets from SSM
// Parameter Store (SSM_ENV maps env var -> parameter name) at cold start, then
// serves the same Express app as the container behind a Lambda function URL.
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import serverless from 'serverless-http';

async function loadSsmEnv(): Promise<void> {
  const mapping = JSON.parse(process.env.SSM_ENV || '{}') as Record<string, string>;
  const entries = Object.entries(mapping);
  if (!entries.length) return;
  const { Parameters = [], InvalidParameters = [] } = await new SSMClient({}).send(new GetParametersCommand({
    Names: entries.map(([, name]) => name),
    WithDecryption: true
  }));
  if (InvalidParameters.length) throw new Error(`Missing SSM parameters: ${InvalidParameters.join(', ')}`);
  const values = new Map(Parameters.map((parameter) => [parameter.Name, parameter.Value]));
  for (const [key, name] of entries) process.env[key] = values.get(name)?.trim();
}

await loadSsmEnv();
const { createApp } = await import('./src/server.js');

// serverless-http hands Express the body as a pre-filled Buffer plus a
// Content-Length header, but an empty stream. Express 5's body parser
// (body-parser 2.x) reads that empty stream and replaces the body with {}.
// So parse JSON here (same 64 KB limit as the container's parser) and drop
// Content-Length, which makes body-parser leave the parsed body alone.
const MAX_JSON_BYTES = 64 * 1024;

export const handler = serverless(createApp(), {
  request(request: { headers: Record<string, string | undefined>; body?: unknown }) {
    if (!Buffer.isBuffer(request.body)) return;
    const isJson = /^application\/json(;|$)/i.test(request.headers['content-type'] || '');
    if (!isJson || request.body.length > MAX_JSON_BYTES) {
      request.body = undefined;
      delete request.headers['content-length'];
      return;
    }
    try {
      request.body = JSON.parse(request.body.toString('utf8'));
    } catch {
      request.body = undefined;
    }
    delete request.headers['content-length'];
  }
});
