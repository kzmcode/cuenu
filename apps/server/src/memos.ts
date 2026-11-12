import type { AiMeta, ImageSummaryState, Memo } from '@cuenu/core';
import type { Db } from './db';

export interface MemoRow {
  id: string;
  parent_id: string | null;
  author: 'user' | 'ai';
  body: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  version: number;
  deleted_at: string | null;
  tags: string;
  tags_version: number | null;
  emoji: string | null;
  liked: number;
  liked_at: string | null;
  ai: string | null;
  image: string | null;
  server_seq: number;
  last_op_id: string | null;
}

function parseJson<T>(s: string | null, def: T): T {
  if (s === null) return def;
  try {
    return JSON.parse(s) as T;
  } catch {
    return def;
  }
}

export function rowToMemo(r: MemoRow): Memo {
  return {
    id: r.id,
    parentId: r.parent_id,
    author: r.author,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    editedAt: r.edited_at,
    version: r.version,
    deletedAt: r.deleted_at,
    tags: parseJson<string[]>(r.tags, []),
    tagsVersion: r.tags_version,
    emoji: r.emoji ?? null,
    liked: r.author === 'ai' ? !!r.liked : false,
    ai: parseJson<AiMeta | null>(r.ai, null),
    image: parseJson<ImageSummaryState | null>(r.image, null),
    serverSeq: r.server_seq,
  };
}

export async function getMemoRow(db: Db, id: string): Promise<MemoRow | null> {
  return db.first<MemoRow>(`SELECT * FROM memos WHERE id = ?`, id);
}
export async function getMemo(db: Db, id: string): Promise<Memo | null> {
  const r = await getMemoRow(db, id);
  return r ? rowToMemo(r) : null;
}
