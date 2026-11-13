import { DEFAULT_EMBED_DIM, DEFAULT_EMBED_MODEL, DEFAULT_GEMINI_MODEL, intVar, type Env } from '../env';
import { AiError, type AiClient, type EmbedTask, type GenerateOptions } from './client';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 25_000;

interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: { '@type'?: string; retryDelay?: string }[] };
}

function parseRetryAfter(res: Response, body: GeminiErrorBody | null): number {
  const h = res.headers.get('retry-after');
  if (h && /^\d+$/.test(h)) return Math.max(1, Number(h));
  const d = body?.error?.details?.find((x) => x['@type']?.includes('RetryInfo'))?.retryDelay;
  if (d) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d);
    if (m) return Math.max(1, Math.ceil(Number(m[1])));
  }
  return 60;
}

class GeminiClient implements AiClient {
  readonly model: string;
  readonly embedModel: string;
  readonly embedDim: number;
  constructor(
    private apiKey: string,
    env: Env,
    // Workers では fetch を別のオブジェクトのメソッドとして呼ぶと Illegal invocation になるため、包んで渡す
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    this.embedModel = env.GEMINI_EMBED_MODEL || DEFAULT_EMBED_MODEL;
    this.embedDim = intVar(env.GEMINI_EMBED_DIM, DEFAULT_EMBED_DIM, 64, 3072);
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(`${BASE}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new AiError('failed', `network error: ${(e as Error).message}`);
    }
    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch {
        throw new AiError('bad_response', `Gemini ${res.status}: invalid JSON body`);
      }
    }
    let err: GeminiErrorBody | null = null;
    try {
      err = (await res.json()) as GeminiErrorBody;
    } catch {
      err = null;
    }
    const msg = `Gemini ${res.status}: ${err?.error?.message?.slice(0, 200) ?? res.statusText}`;
    if (res.status === 429) throw new AiError('rate_limited', msg, parseRetryAfter(res, err));
    if (res.status === 401 || res.status === 403) throw new AiError('unavailable', msg);
    if (res.status >= 500) throw new AiError('failed', msg, 30);
    throw new AiError('failed', msg);
  }

  async generate(opts: GenerateOptions): Promise<string> {
    const parts: unknown[] = [];
    if (opts.image) parts.push({ inlineData: { mimeType: opts.image.mimeType, data: opts.image.dataBase64 } });
    parts.push({ text: opts.user });
    const generationConfig: Record<string, unknown> = {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
    };
    if (opts.schema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = opts.schema;
    }
    const r = await this.call<{
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    }>(`models/${encodeURIComponent(this.model)}:generateContent`, {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
    });
    if (r.promptFeedback?.blockReason) throw new AiError('bad_response', `blocked: ${r.promptFeedback.blockReason}`);
    const text = r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new AiError('bad_response', `empty response (${r.candidates?.[0]?.finishReason ?? 'unknown'})`);
    return text;
  }

  async embed(texts: string[], task: EmbedTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    const model = `models/${this.embedModel}`;
    const r = await this.call<{ embeddings?: { values?: number[] }[] }>(
      `models/${encodeURIComponent(this.embedModel)}:batchEmbedContents`,
      {
        requests: texts.map((t) => ({
          model,
          content: { parts: [{ text: t }] },
          taskType: task,
          outputDimensionality: this.embedDim,
        })),
      },
    );
    const out = (r.embeddings ?? []).map((e) => e.values ?? []);
    if (out.length !== texts.length || out.some((v) => v.length !== this.embedDim)) {
      throw new AiError('bad_response', 'unexpected embedding shape');
    }
    return out;
  }
}

export function createAiClient(env: Env, fetcher: typeof fetch = (input, init) => fetch(input, init)): AiClient | null {
  return env.GEMINI_API_KEY ? new GeminiClient(env.GEMINI_API_KEY, env, fetcher) : null;
}
