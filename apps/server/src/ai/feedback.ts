// AI 投稿への反応（いいね・返信・非表示・無反応）を評価し、次の提案生成に反映する。
// - 学習はモデルの再訓練ではなく「過去の反応をプロンプトに渡す」「反応が悪い種別ほど確信度のしきい値を上げる」で行う
// - 無反応は弱い否定として扱うが、催促の理由にはしない（要件 8 章）
// - 返信内容から推測したラベルは提案生成の参考にだけ使い、タスク状態として画面に出さない
import type { AiPostKind } from '@cuenu/core';
import type { Ctx } from '../context';
import { stmt, type Db, type Stmt } from '../db';
import type { MemoRow } from '../memos';
import { generateJson, type AiClient } from './client';
import { DATA_RULE, memoTag } from './prompt';

export type ReplyLabel = 'adopted' | 'done' | 'later' | 'declined' | 'neutral';
export type FeedbackSignal = 'liked' | 'adopted' | 'done' | 'later' | 'declined' | 'hidden' | 'ignored' | 'replied' | 'pending';

/** この時間反応がなければ「反応なし」とみなす */
const IGNORE_AFTER_HOURS = 72;
/** 評価対象にする直近の AI 投稿数 */
const EVAL_WINDOW = 40;
const LABEL_BATCH = 20;
const EXAMPLES = 12;
const LABELS: ReplyLabel[] = ['adopted', 'done', 'later', 'declined', 'neutral'];

export const SIGNAL_SCORE: Record<Exclude<FeedbackSignal, 'pending'>, number> = {
  liked: 0.8,
  adopted: 1,
  done: 1,
  later: 0.2,
  replied: 0.3,
  declined: -1,
  hidden: -1,
  ignored: -0.4,
};

export const SIGNAL_LABEL_JA: Record<FeedbackSignal, string> = {
  liked: 'いいね',
  adopted: '採用・やってみる',
  done: '実行した',
  later: 'あとで',
  replied: '返信あり',
  declined: '見送り・不要',
  hidden: '非表示にされた',
  ignored: '反応なし',
  pending: '評価待ち',
};

/** 見送り・辞退の表現（提案生成の除外判定でも使う） */
export const DECLINE_RE = /見送|不要|いらない|要らない|やめ|止め|やらない|しない|却下|スキップ|今回はパス|no thanks/i;
const DONE_RE = /完了|できた|やった|終わった|済み|済んだ|対応した|送った|返信した|試した|試作した|作った/;
const ADOPT_RE = /採用|やってみ|試す|試そう|やる|やろう|いいね|良さそう|よさそう|ありがと|参考にな|助か|賛成/;
const LATER_RE = /あとで|後で|いつか|そのうち|保留|今度|また今度/;

/** 明確な表現だけを規則で判定する。判定できなければ null（AI に分類させる） */
export function ruleLabel(body: string): ReplyLabel | null {
  const t = body.normalize('NFKC');
  if (DECLINE_RE.test(t)) return 'declined';
  if (DONE_RE.test(t)) return 'done';
  if (ADOPT_RE.test(t)) return 'adopted';
  if (LATER_RE.test(t)) return 'later';
  return null;
}

export interface PostReaction {
  hidden: boolean;
  liked: boolean;
  /** ユーザー返信のラベル（古い順）。未分類は neutral */
  replyLabels: ReplyLabel[];
  createdAt: string;
}

/** 1 件の AI 投稿の反応を評価する（純関数） */
export function evaluateReaction(r: PostReaction, now: Date): { signal: FeedbackSignal; score: number } {
  if (r.hidden) return { signal: 'hidden', score: SIGNAL_SCORE.hidden };
  const latest = r.replyLabels[r.replyLabels.length - 1];
  if (!r.liked && !latest) {
    const ageH = (now.getTime() - Date.parse(r.createdAt)) / 3600_000;
    return ageH >= IGNORE_AFTER_HOURS ? { signal: 'ignored', score: SIGNAL_SCORE.ignored } : { signal: 'pending', score: 0 };
  }
  // 最新の返信の意思を優先（「採用」のあと「やっぱりやめた」なら見送り）
  const replySignal: FeedbackSignal | null = latest ? (latest === 'neutral' ? 'replied' : latest) : null;
  let score = (r.liked ? SIGNAL_SCORE.liked : 0) + (replySignal ? SIGNAL_SCORE[replySignal as keyof typeof SIGNAL_SCORE] : 0);
  if (replySignal === 'declined') score = Math.min(score, -0.6); // いいね済みでも、明示の見送りを優先
  score = Math.max(-1, Math.min(1, score));
  const order: FeedbackSignal[] = ['declined', 'done', 'adopted', 'liked', 'later', 'replied'];
  const present = new Set<FeedbackSignal>([...(replySignal ? [replySignal] : []), ...(r.liked ? (['liked'] as const) : [])]);
  const signal = order.find((s) => present.has(s)) ?? 'replied';
  return { signal, score };
}

const LABEL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    labels: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'STRING' }, label: { type: 'STRING', enum: LABELS } },
        required: ['id', 'label'],
      },
    },
  },
  required: ['labels'],
};

/** 規則で判定できない返信を AI で分類する。失敗時は空（次回再試行。提案生成は止めない） */
async function classifyReplies(ai: AiClient, items: { reply: MemoRow; post: MemoRow }[]): Promise<Map<string, ReplyLabel>> {
  const out = new Map<string, ReplyLabel>();
  if (items.length === 0) return out;
  try {
    const r = await generateJson<{ labels?: { id: string; label: string }[] }>(ai, {
      system: [
        'あなたは、AI の提案に対してユーザーが書いた返信が、提案をどう受け止めたかを分類します。',
        DATA_RULE,
        'label: adopted=採用・やってみる・前向き / done=実行した・完了した / later=あとでやる・保留 / declined=不要・見送る・違う・的外れ / neutral=どれでもない・判断できない。',
        '判断できない場合は neutral。出力は指定 JSON のみ。',
      ].join('\n'),
      user: items
        .map(({ reply, post }) =>
          [memoTag({ id: `ai-${reply.id}`, role: 'ai_suggestion' }, post.body, 400), memoTag({ id: reply.id, role: 'user_reply' }, reply.body, 400)].join('\n'),
        )
        .join('\n\n'),
      schema: LABEL_SCHEMA,
      temperature: 0,
    });
    const ids = new Set(items.map((i) => i.reply.id));
    for (const l of r.labels ?? []) {
      if (ids.has(l.id) && LABELS.includes(l.label as ReplyLabel)) out.set(l.id, l.label as ReplyLabel);
    }
  } catch (e) {
    console.warn('reply classification failed', e instanceof Error ? e.message : e);
  }
  return out;
}

/** 直近の AI 投稿の反応を評価して ai_feedback を更新する。戻り値は評価した件数 */
export async function evaluateFeedback(ctx: Ctx, ai: AiClient | null): Promise<number> {
  const db = ctx.db;
  const now = ctx.now();
  const nowIso = now.toISOString();
  const posts = await db.all<MemoRow>(`SELECT * FROM memos WHERE author = 'ai' ORDER BY created_at DESC LIMIT ?`, EVAL_WINDOW);
  if (posts.length === 0) return 0;
  const ids = posts.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const replies = await db.all<MemoRow>(
    `SELECT * FROM memos WHERE author = 'user' AND deleted_at IS NULL AND parent_id IN (${ph}) ORDER BY created_at ASC`,
    ...ids,
  );
  const known = new Map(
    (
      await db.all<{ reply_id: string; version: number; label: ReplyLabel }>(
        `SELECT reply_id, version, label FROM ai_reply_labels WHERE reply_id IN (${replies.map(() => '?').join(',') || "''"})`,
        ...replies.map((r) => r.id),
      )
    ).map((k) => [k.reply_id, k]),
  );

  const writes: Stmt[] = [];
  const labels = new Map<string, ReplyLabel>();
  const toAi: { reply: MemoRow; post: MemoRow }[] = [];
  for (const r of replies) {
    const k = known.get(r.id);
    if (k && k.version === r.version) {
      labels.set(r.id, k.label);
      continue;
    }
    const rule = ruleLabel(r.body);
    if (rule) {
      labels.set(r.id, rule);
      writes.push(upsertLabel(r, rule, nowIso));
    } else if (toAi.length < LABEL_BATCH) {
      toAi.push({ reply: r, post: posts.find((p) => p.id === r.parent_id)! });
    }
  }
  if (ai) {
    for (const [id, label] of await classifyReplies(ai, toAi)) {
      labels.set(id, label);
      writes.push(upsertLabel(replies.find((r) => r.id === id)!, label, nowIso));
    }
  }

  const summaries = new Map(
    (await db.all<{ memo_id: string; summary: string }>(`SELECT memo_id, summary FROM ai_posts WHERE memo_id IN (${ph})`, ...ids)).map(
      (s) => [s.memo_id, s.summary],
    ),
  );
  for (const p of posts) {
    const meta = p.ai ? (JSON.parse(p.ai) as { kind?: AiPostKind }) : {};
    const { signal, score } = evaluateReaction(
      {
        hidden: !!p.deleted_at,
        liked: !!p.liked,
        replyLabels: replies.filter((r) => r.parent_id === p.id).map((r) => labels.get(r.id) ?? 'neutral'),
        createdAt: p.created_at,
      },
      now,
    );
    writes.push(
      stmt(
        `INSERT INTO ai_feedback (memo_id, kind, summary, signal, score, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(memo_id) DO UPDATE SET kind = excluded.kind, summary = excluded.summary, signal = excluded.signal,
           score = excluded.score, evaluated_at = excluded.evaluated_at`,
        p.id,
        meta.kind ?? 'action',
        (summaries.get(p.id) ?? p.body).slice(0, 200),
        signal,
        score,
        nowIso,
      ),
    );
  }
  await db.batch(writes);
  return posts.length;
}

function upsertLabel(r: MemoRow, label: ReplyLabel, nowIso: string): Stmt {
  return stmt(
    `INSERT INTO ai_reply_labels (reply_id, version, label, labeled_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(reply_id) DO UPDATE SET version = excluded.version, label = excluded.label, labeled_at = excluded.labeled_at`,
    r.id,
    r.version,
    label,
    nowIso,
  );
}

export interface FeedbackExample {
  memoId: string;
  kind: AiPostKind;
  summary: string;
  signal: FeedbackSignal;
  score: number;
}

export interface FeedbackContext {
  examples: FeedbackExample[];
  /** 種別ごとの評価件数と平均スコア */
  kindStats: Partial<Record<AiPostKind, { n: number; avg: number }>>;
  bySignal: Map<string, FeedbackSignal>;
}

export async function loadFeedback(db: Db): Promise<FeedbackContext> {
  const rows = await db.all<{ memo_id: string; kind: AiPostKind; summary: string; signal: FeedbackSignal; score: number }>(
    `SELECT f.memo_id, f.kind, f.summary, f.signal, f.score FROM ai_feedback f
     JOIN memos m ON m.id = f.memo_id
     WHERE f.signal != 'pending'
     ORDER BY m.created_at DESC LIMIT ?`,
    EVAL_WINDOW,
  );
  const kindStats: FeedbackContext['kindStats'] = {};
  for (const r of rows) {
    const s = (kindStats[r.kind] ??= { n: 0, avg: 0 });
    s.avg = (s.avg * s.n + r.score) / (s.n + 1);
    s.n++;
  }
  const all = await db.all<{ memo_id: string; signal: FeedbackSignal }>(`SELECT memo_id, signal FROM ai_feedback`);
  return {
    examples: rows.slice(0, EXAMPLES).map((r) => ({ memoId: r.memo_id, kind: r.kind, summary: r.summary, signal: r.signal, score: r.score })),
    kindStats,
    bySignal: new Map(all.map((a) => [a.memo_id, a.signal])),
  };
}

/**
 * 種別ごとの確信度しきい値。反応が良い種別は少し出やすく、悪い種別は出にくくする。
 * 評価が 3 件未満の種別は既定値のまま。
 */
export function kindMinConfidence(stats: FeedbackContext['kindStats'], kind: AiPostKind, base: number): number {
  const s = stats[kind];
  if (!s || s.n < 3) return base;
  return Math.max(0.5, Math.min(0.85, base - 0.2 * s.avg));
}
