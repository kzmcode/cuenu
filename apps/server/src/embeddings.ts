// 埋め込みの量子化保存と意味検索。
// 方式: 次元を落とした埋め込み（既定 256）を L2 正規化 → int8 量子化して D1 に base64 保存。
// 検索は「最近 N 件（SEMANTIC_SCAN_LIMIT）」＋「クエリに含まれる既存タグを持つメモ（上限 TAG_CANDIDATES）」だけを走査する。
import type { SemanticSearchResponse } from '@cuenu/core';
import type { AiClient } from './ai/client';
import type { Db } from './db';
import { intVar, type Env } from './env';
import { b64Decode, b64Encode } from './util';
import { tagKey } from './ai/tags';

export const DEFAULT_SCAN_LIMIT = 2000;
const TAG_CANDIDATES = 300;

export interface Quantized {
  vector: string;
  scale: number;
}

export function quantize(v: number[]): Quantized {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  let maxAbs = 0;
  const n = v.map((x) => x / norm);
  for (const x of n) maxAbs = Math.max(maxAbs, Math.abs(x));
  if (maxAbs === 0) maxAbs = 1;
  const q = new Int8Array(n.length);
  for (let i = 0; i < n.length; i++) q[i] = Math.round((n[i]! / maxAbs) * 127);
  return { vector: b64Encode(new Uint8Array(q.buffer)), scale: maxAbs };
}

export function dequantizeView(vector: string): Int8Array {
  const b = b64Decode(vector);
  return new Int8Array(b.buffer, b.byteOffset, b.byteLength);
}

/** 量子化ベクトル同士のコサイン類似度（近似） */
export function cosineQ(a: Int8Array, sa: number, b: Int8Array, sb: number): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return (dot * sa * sb) / (127 * 127);
}

interface EmbRow {
  memo_id: string;
  vector: string;
  scale: number;
}

export function scanLimit(env: Env): number {
  return intVar(env.SEMANTIC_SCAN_LIMIT, DEFAULT_SCAN_LIMIT, 100, 20000);
}

/** 候補集合を走査してスコア上位を返す */
export async function nearest(
  db: Db,
  env: Env,
  ai: AiClient,
  query: Quantized,
  opts: { limit: number; tagHints?: string[]; excludeIds?: Set<string> },
): Promise<{ memoId: string; score: number }[]> {
  const recent = await db.all<EmbRow>(
    `SELECT memo_id, vector, scale FROM embeddings WHERE model = ? AND dim = ?
     ORDER BY memo_created_at DESC LIMIT ?`,
    ai.embedModel,
    ai.embedDim,
    scanLimit(env),
  );
  const rows = new Map(recent.map((r) => [r.memo_id, r]));
  for (const tag of (opts.tagHints ?? []).slice(0, 5)) {
    const extra = await db.all<EmbRow>(
      `SELECT e.memo_id, e.vector, e.scale FROM embeddings e JOIN memos m ON m.id = e.memo_id
       WHERE e.model = ? AND e.dim = ? AND m.deleted_at IS NULL AND m.tags LIKE ? LIMIT ?`,
      ai.embedModel,
      ai.embedDim,
      `%${JSON.stringify(tag).replace(/[%_]/g, '')}%`,
      TAG_CANDIDATES,
    );
    for (const r of extra) rows.set(r.memo_id, r);
  }
  const qv = dequantizeView(query.vector);
  const hits: { memoId: string; score: number }[] = [];
  for (const r of rows.values()) {
    if (opts.excludeIds?.has(r.memo_id)) continue;
    const score = cosineQ(qv, query.scale, dequantizeView(r.vector), r.scale);
    if (score > 0) hits.push({ memoId: r.memo_id, score: Math.round(score * 1000) / 1000 });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, opts.limit);
}

/** クエリ文字列に含まれる既存タグ（語彙）を候補絞り込みのヒントにする */
export function tagHintsFor(query: string, vocabulary: string[]): string[] {
  const qk = tagKey(query);
  return vocabulary.filter((t) => {
    const k = tagKey(t);
    return k.length >= 2 && qk.includes(k);
  });
}

export async function tagVocabulary(db: Db, recent = 300, max = 60): Promise<string[]> {
  const rows = await db.all<{ tags: string }>(
    `SELECT tags FROM memos WHERE deleted_at IS NULL AND tags != '[]' ORDER BY server_seq DESC LIMIT ?`,
    recent,
  );
  const count = new Map<string, number>();
  for (const r of rows) {
    try {
      for (const t of JSON.parse(r.tags) as string[]) count.set(t, (count.get(t) ?? 0) + 1);
    } catch {
      /* ignore */
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

export async function indexCounts(db: Db, ai: AiClient): Promise<{ indexedCount: number; pendingCount: number }> {
  const idx = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM embeddings WHERE model = ? AND dim = ?`,
    ai.embedModel,
    ai.embedDim,
  );
  const pend = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM memos m WHERE m.author = 'user' AND m.deleted_at IS NULL AND m.body != ''
     AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.memo_id = m.id AND e.model = ? AND e.dim = ?)`,
    ai.embedModel,
    ai.embedDim,
  );
  return { indexedCount: idx?.n ?? 0, pendingCount: pend?.n ?? 0 };
}

export async function semanticSearch(
  db: Db,
  env: Env,
  ai: AiClient,
  query: string,
  limit: number,
): Promise<SemanticSearchResponse> {
  const [vec] = await ai.embed([query.slice(0, 1000)], 'RETRIEVAL_QUERY');
  const vocab = await tagVocabulary(db);
  const hits = await nearest(db, env, ai, quantize(vec!), { limit, tagHints: tagHintsFor(query, vocab) });
  return { hits, ...(await indexCounts(db, ai)) };
}
