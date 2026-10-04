import express, { type Response } from 'express';
import { answerLicenseQuestion } from './openai-assistant.js';
import type { ChatMessage, RecordValue } from './types.js';

function sendJson(response: Response, status: number, body: RecordValue): void {
  response.status(status).json(body);
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

export function startServer(): void {
  const app = express();
  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (origin === (process.env.UI_ORIGIN || 'http://localhost:5173') || origin === 'http://127.0.0.1:5173') {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.sendStatus(204); return; }
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  app.get('/', (_request, response) => sendJson(response, 200, {
    service: 'app-usage-monitor-agent', purpose: 'read-only license monitoring assistant',
    status: 'ok', assistantEndpoint: 'POST /api/assistant/chat'
  }));
  app.get('/health', (_request, response) => sendJson(response, 200, { status: 'ok' }));
  app.post('/api/assistant/chat', async (request, response) => {
    const messages = parseMessages(request.body?.messages);
    if (!messages.some((item) => item.role === 'user')) {
      sendJson(response, 400, { error: 'A user message is required.' });
      return;
    }
    try {
      sendJson(response, 200, await answerLicenseQuestion(messages));
    } catch (error: unknown) {
      console.error('License assistant request failed:', error instanceof Error ? error.message : String(error));
      sendJson(response, 502, { error: 'Unable to prepare a license-monitoring answer right now.' });
    }
  });

  const port = Number(process.env.PORT || 3002);
  app.listen(port, () => console.log(`License monitoring assistant listening on port ${port}`));
}
