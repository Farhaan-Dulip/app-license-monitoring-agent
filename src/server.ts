import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { answerLicenseQuestion } from './openai-assistant.js';
import type { ChatContext, ChatMessage, RecordValue } from './types.js';

function sendJson(response: Response, status: number, body: RecordValue): void {
  response.status(status).json(body);
}

function tokenMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function requireServiceToken(request: Request, response: Response, next: NextFunction): void {
  const expected = process.env.MCP_SERVICE_TOKEN?.trim();
  if (!expected) {
    sendJson(response, 503, { error: 'Service authentication is not configured.' });
    return;
  }
  if (!tokenMatches(request.get('X-MCP-Service-Token'), expected)) {
    sendJson(response, 401, { error: 'Unauthorized.' });
    return;
  }
  next();
}

function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item: unknown) => {
      const message = item as Partial<ChatMessage>;
      return (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' && Boolean(message.content.trim());
    })
    .slice(-10)
    .map((item: ChatMessage) => ({ role: item.role, content: item.content.trim().slice(0, 2000) }));
}

function parseContext(body: RecordValue | undefined): ChatContext {
  const requester = body?.requester as RecordValue | undefined;
  const name = String(requester?.name || '').trim().slice(0, 200);
  const email = String(requester?.email || '').trim().toLowerCase();
  const clientId = String(body?.clientId || '').trim().slice(0, 200);
  return {
    ...(name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { requester: { name, email } } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

// The browser never calls this service: only the portal does, over the private
// network, with the shared service token.
export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/', (_request, response) => sendJson(response, 200, {
    service: 'app-usage-monitor-agent', purpose: 'license monitoring assistant; raises license requests for owner approval',
    status: 'ok', assistantEndpoint: 'POST /api/assistant/chat'
  }));
  app.get('/health', (_request, response) => sendJson(response, 200, { status: 'ok' }));
  app.post('/api/assistant/chat', requireServiceToken, async (request, response) => {
    const messages = parseMessages(request.body?.messages);
    if (!messages.some((item) => item.role === 'user')) {
      sendJson(response, 400, { error: 'A user message is required.' });
      return;
    }
    try {
      sendJson(response, 200, await answerLicenseQuestion(messages, parseContext(request.body)));
    } catch (error: unknown) {
      console.error('License assistant request failed:', error instanceof Error ? error.message : String(error));
      sendJson(response, 502, { error: 'Unable to prepare a license-monitoring answer right now.' });
    }
  });
  return app;
}

export function startServer(): void {
  const port = Number(process.env.PORT || 3002);
  createApp().listen(port, () => console.log(`License monitoring assistant listening on port ${port}`));
}
