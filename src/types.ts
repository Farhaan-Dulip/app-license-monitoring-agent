export type RecordValue = Record<string, unknown>;

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type OpenAIItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
};

export type OpenAIResponse = {
  output_text?: string;
  output?: OpenAIItem[];
  error?: { message?: string };
};
