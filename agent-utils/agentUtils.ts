import { z } from 'zod';
import { optionalEnv, requiredEnv } from '../services/runtime/runtime.js';

// Extracts plain text from OpenAI Chat Completions JSON mode responses.
export function extractChatCompletionText(payload: unknown): string {
  const parsedPayload = z.object({
    choices: z.array(z.object({
      message: z.object({
        content: z.string().nullable()
      })
    }))
  }).parse(payload);
  const content = parsedPayload.choices[0]?.message.content;
  if (!content) {
    throw new Error('OpenAI response did not contain text content.');
  }
  return content;
}

// Calls OpenAI and returns raw JSON so agents can normalize common model shape drift before validation.
export async function callOpenAiJsonStrictRaw(prompt: string): Promise<unknown> {
  const apiKey = requiredEnv('OPENAI_API_KEY');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: optionalEnv('OPENAI_MODEL') ?? 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are an autonomous senior React product designer and frontend engineer. Generate polished, production-quality UI, not default HTML. Return valid JSON only. Do not include markdown fences.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI React code generation failed with ${response.status}: ${await response.text()}`);
  }

  return JSON.parse(extractChatCompletionText(await response.json()));
}

// Converts flexible LLM values into plain text for strict internal contracts.
export function valueToText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const joined = value.map((item) => valueToText(item, '')).filter(Boolean).join(', ');
    return joined || fallback;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferredValue = record.value ?? record.name ?? record.label ?? record.title ?? record.text ?? record.description;
    if (preferredValue !== undefined) {
      return valueToText(preferredValue, fallback);
    }

    const flattened = Object.entries(record)
      .map(([key, item]) => `${key}: ${valueToText(item, '')}`)
      .filter((item) => !item.endsWith(': '))
      .join(', ');
    return flattened || fallback;
  }

  return fallback;
}

// Converts flexible LLM arrays/objects into a plain string array.
export function valueToTextArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => valueToText(item, '')).filter(Boolean);
    return normalized.length > 0 ? normalized : fallback;
  }

  if (value && typeof value === 'object') {
    const normalized = Object.values(value as Record<string, unknown>).map((item) => valueToText(item, '')).filter(Boolean);
    return normalized.length > 0 ? normalized : fallback;
  }

  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  }

  return fallback;
}
