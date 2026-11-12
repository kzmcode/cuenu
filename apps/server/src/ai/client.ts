// AI クライアント抽象。実装は Gemini（gemini.ts）。テストではモックを注入する。

export interface InlineImage {
  mimeType: string;
  dataBase64: string;
}

export interface GenerateOptions {
  system: string;
  user: string;
  image?: InlineImage;
  /** 指定時は JSON モード（responseSchema） */
  schema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface AiClient {
  readonly model: string;
  readonly embedModel: string;
  readonly embedDim: number;
  generate(opts: GenerateOptions): Promise<string>;
  embed(texts: string[], task: EmbedTask): Promise<number[][]>;
}

export type AiErrorKind = 'rate_limited' | 'unavailable' | 'bad_response' | 'failed';

export class AiError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

export async function generateJson<T>(ai: AiClient, opts: GenerateOptions): Promise<T> {
  const text = await ai.generate(opts);
  try {
    return JSON.parse(stripFence(text)) as T;
  } catch {
    throw new AiError('bad_response', 'AI returned invalid JSON');
  }
}

function stripFence(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s);
  return m ? m[1]! : s;
}
