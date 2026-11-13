import { describe, expect, test } from 'vitest';
import { HttpError, readJson } from '../src/http';

function streamed(text: string): Request {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 4) c.enqueue(bytes.slice(i, i + 4));
      c.close();
    },
  });
  // Content-Length なし（chunked 相当）
  return new Request('https://x.example/api', { method: 'POST', body, duplex: 'half' } as RequestInit);
}

describe('readJson', () => {
  test('parses a body within the limit', async () => {
    expect(await readJson(streamed('{"a":"あ"}'), 100)).toEqual({ a: 'あ' });
  });

  test('limits by bytes even without content-length', async () => {
    // 6 文字だが UTF-8 では 18 バイト
    const err = await readJson(streamed('"ああああ"'), 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  });

  test('rejects by content-length before reading', async () => {
    const r = new Request('https://x.example/api', { method: 'POST', body: '{}', headers: { 'content-length': '999' } });
    await expect(readJson(r, 10)).rejects.toMatchObject({ status: 413 });
  });

  test('invalid JSON is 400', async () => {
    await expect(readJson(streamed('{'), 100)).rejects.toMatchObject({ status: 400 });
  });
});
