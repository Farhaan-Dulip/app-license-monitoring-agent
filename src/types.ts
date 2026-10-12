export type RecordValue = Record<string, unknown>;

/** Who the conversation is for, supplied by the portal (never by the model). */
export type ChatContext = {
  requester?: { name: string; email: string };
  clientId?: string;
};

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
