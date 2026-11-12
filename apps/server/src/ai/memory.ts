// 長期記憶：古いメモを週・月ごとの要約として保持する。
// - 直近 RECENT_DAYS 日より前の「完了した週」を週の要約にする
// - MONTH_AFTER_DAYS 日より前の月は、その月の週の要約をまとめた月の要約にする
// - 提案生成では、古い期間は要約だけを渡し、最近のメモと関連メモだけを個別に読む（全件は読まない）
// - 元のメモが後から追加・編集・削除されたら（指紋が変わったら）その期間だけ作り直す
// - 1 回の定期処理で作る要約は MAX_PER_RUN 件まで。残りは次回以降
import type { UserSettings } from '@cuenu/core';
import type { Ctx } from '../context';
import { stmt, type Db } from '../db';
import { addDays, localDay, localDayStartUtc, weekStart } from '../util';
import { generateJson, type AiClient } from './client';
import { DATA_RULE, escapeData, memoTag } from './prompt';

/** これより新しいメモは要約せず、個別のメモとして扱う */
export const RECENT_DAYS = 14;
/** これより古い月は、週の要約をまとめた月の要約にする */
export const MONTH_AFTER_DAYS = 90;
export const MAX_PER_RUN = 3;
/** 1 週の要約に渡すメモの上限（超えたら長いものを優先して切り詰める） */
const MAX_MEMOS_PER_WEEK = 120;
const BODY_MAX = 300;
/** 提案生成に渡す要約の件数 */
export const CONTEXT_WEEKS = 8;
export const CONTEXT_MONTHS = 12;
/** 一度に遡る週の数（初回に大量の過去データがある場合も少しずつ進める） */
const SCAN_WEEKS = 160;

const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    topics: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'topics'],
};

export interface MemoryRow {
  id: string;
  level: 'week' | 'month';
  period_start: string;
  period_end: string;
  summary: string;
  topics: string;
  memo_count: number;
  fingerprint: string;
  model: string;
  updated_at: string;
}

interface WeekStat {
  start: string;
  count: number;
  fingerprint: string;
}

/** tz の現在の UTC からのずれ（分）。週の区切りに使う（夏時間の切り替え週は数時間ずれうる） */
export function tzOffsetMinutes(now: Date, tz: string): number {
  const startUtc = Date.parse(localDayStartUtc(localDay(now, tz), tz));
  const localMidnightAsUtc = Date.parse(localDay(now, tz) + 'T00:00:00Z');
  return Math.round((localMidnightAsUtc - startUtc) / 60000);
}

/** 週（月曜始まり、tz の日付）の開始を UTC ISO に */
const weekFromUtc = (week: string, offsetMin: number) => new Date(Date.parse(week + 'T00:00:00Z') - offsetMin * 60000).toISOString();

/**
 * 週ごとのメモ件数と指紋（件数・本文版の合計・本文長の合計。追加・編集・削除で変わる）。
 * Workers Free は 1 回の実行で送れる D1 クエリ数に上限があるため、1 クエリで週ごとに集計する。
 */
async function weekStats(db: Db, offsetMin: number, beforeWeek: string): Promise<WeekStat[]> {
  const mod = `${offsetMin >= 0 ? '+' : ''}${offsetMin} minutes`;
  const rows = await db.all<{ wk: string; n: number; v: number; l: number }>(
    `SELECT date(created_at, ?, 'weekday 0', '-6 days') AS wk, COUNT(*) AS n, SUM(version) AS v, SUM(LENGTH(body)) AS l
     FROM memos WHERE author = 'user' AND deleted_at IS NULL AND created_at < ?
     GROUP BY wk ORDER BY wk DESC LIMIT ?`,
    mod,
    weekFromUtc(beforeWeek, offsetMin),
    SCAN_WEEKS,
  );
  return rows.map((r) => ({ start: r.wk, count: r.n, fingerprint: `${r.n}:${r.v}:${r.l}` }));
}

async function summarize(ai: AiClient, kind: 'week' | 'month', period: string, items: string[]): Promise<{ summary: string; topics: string[] }> {
  const r = await generateJson<{ summary?: unknown; topics?: unknown }>(ai, {
    system: [
      kind === 'week'
        ? 'あなたは個人用メモアプリの記録係です。ある 1 週間にユーザーが書いたメモ（返信を含む）を、あとで振り返るための要約にします。'
        : 'あなたは個人用メモアプリの記録係です。ある 1 か月の週ごとの要約を、1 か月分の要約にまとめます。',
      DATA_RULE,
      '要約には、主な話題、決めたこと・やったこと、続いている悩みや関心、考えの変化を含めます。',
      'メモに書かれた事実と推測を区別し、書かれていないことを補わないでください。固有名詞や期限は書かれていた通りに残します。',
      `summary は日本語 ${kind === 'week' ? 400 : 500} 字程度まで。topics は主な話題を表す短い名詞を 0〜6 個。出力は指定 JSON のみ。`,
    ].join('\n'),
    user: [`期間: ${period}`, '', ...items].join('\n'),
    schema: SUMMARY_SCHEMA,
    temperature: 0.2,
    maxOutputTokens: 1024,
  });
  const summary = typeof r.summary === 'string' ? r.summary.trim().slice(0, 1200) : '';
  const topics = Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 24)).filter(Boolean).slice(0, 6) : [];
  return { summary, topics };
}

function upsertMemory(row: Omit<MemoryRow, 'topics'> & { topics: string[] }) {
  return stmt(
    `INSERT INTO ai_memory (id, level, period_start, period_end, summary, topics, memo_count, fingerprint, model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, topics = excluded.topics, memo_count = excluded.memo_count,
       fingerprint = excluded.fingerprint, model = excluded.model, updated_at = excluded.updated_at`,
    row.id,
    row.level,
    row.period_start,
    row.period_end,
    row.summary,
    JSON.stringify(row.topics),
    row.memo_count,
    row.fingerprint,
    row.model,
    row.updated_at,
  );
}

/**
 * 要約が無い・古くなった期間を見つけて、新しい順に最大 MAX_PER_RUN 件作り直す。
 * 戻り値は作った（更新した）要約の数。AI エラーは呼び出し元へ送出（429 で AI 全体を一時停止させるため）
 */
export async function refreshMemory(ctx: Ctx, ai: AiClient, settings: UserSettings): Promise<number> {
  const db = ctx.db;
  const tz = settings.timezone;
  const now = ctx.now();
  const today = localDay(now, tz);
  const recentCut = weekStart(addDays(today, -RECENT_DAYS)); // この週より前の完了した週が要約対象
  const monthCut = addDays(today, -MONTH_AFTER_DAYS).slice(0, 7); // この月より前は月の要約

  const offsetMin = tzOffsetMinutes(now, tz);
  const stats = await weekStats(db, offsetMin, recentCut);
  const live = new Set(stats.map((s) => `week:${s.start}`));
  // 集計は新しい SCAN_WEEKS 週まで。それより古い期間は「消えた」と判定できないので残す
  const floor = stats.length >= SCAN_WEEKS ? stats[stats.length - 1]!.start : '';
  const existing = new Map((await db.all<MemoryRow>(`SELECT * FROM ai_memory`)).map((m) => [m.id, m]));
  // 元のメモがすべて消えた週の要約は削除する（集計に出てこない週）
  const gone = [...existing.values()].filter(
    (m) => m.level === 'week' && !live.has(m.id) && m.period_start < recentCut && m.period_start >= floor,
  );
  if (gone.length) {
    await db.batch(gone.map((m) => stmt(`DELETE FROM ai_memory WHERE id = ?`, m.id)));
    for (const m of gone) existing.delete(m.id);
  }
  const liveMonths = new Set(stats.map((s) => s.start.slice(0, 7)));
  const goneMonths = [...existing.values()].filter(
    (m) => m.level === 'month' && !liveMonths.has(m.period_start.slice(0, 7)) && m.period_start.slice(0, 7) >= floor.slice(0, 7),
  );
  if (goneMonths.length) {
    await db.batch(goneMonths.map((m) => stmt(`DELETE FROM ai_memory WHERE id = ?`, m.id)));
    for (const m of goneMonths) existing.delete(m.id);
  }
  if (stats.length === 0) return 0;
  let made = 0;
  // AI 呼び出し回数（空の応答も数える。1 回の実行で呼びすぎない）
  let calls = 0;

  // 1) 週の要約（新しい週から）
  for (const s of stats) {
    if (calls >= MAX_PER_RUN) return made;
    const id = `week:${s.start}`;
    const cur = existing.get(id);
    if (cur && cur.fingerprint === s.fingerprint) continue;
    const from = weekFromUtc(s.start, offsetMin);
    const to = weekFromUtc(addDays(s.start, 7), offsetMin);
    const rows = await db.all<{ id: string; parent_id: string | null; created_at: string; body: string }>(
      `SELECT id, parent_id, created_at, body FROM memos
       WHERE author = 'user' AND deleted_at IS NULL AND created_at >= ? AND created_at < ?
       ORDER BY LENGTH(body) DESC LIMIT ?`,
      from,
      to,
      MAX_MEMOS_PER_WEEK,
    );
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const items = rows.map((r) => memoTag({ created: r.created_at, ...(r.parent_id ? { kind: 'reply' } : {}) }, r.body, BODY_MAX));
    if (s.count > rows.length) items.push(`（ほかに短いメモが ${s.count - rows.length} 件あります）`);
    const { summary, topics } = await summarize(ai, 'week', `${s.start}〜${addDays(s.start, 6)}（${tz}）`, items);
    calls++;
    if (!summary) continue;
    await db.batch([
      upsertMemory({
        id,
        level: 'week',
        period_start: s.start,
        period_end: addDays(s.start, 7),
        summary,
        topics,
        memo_count: s.count,
        fingerprint: s.fingerprint,
        model: ai.model,
        updated_at: now.toISOString(),
      }),
    ]);
    existing.set(id, { id, level: 'week', period_start: s.start, period_end: addDays(s.start, 7), summary, topics: JSON.stringify(topics), memo_count: s.count, fingerprint: s.fingerprint, model: ai.model, updated_at: now.toISOString() });
    made++;
  }

  // 2) 月の要約（その月の週の要約がすべて最新になってから、週の要約をまとめる）
  const byMonth = new Map<string, WeekStat[]>();
  for (const s of stats) {
    const m = s.start.slice(0, 7);
    if (m >= monthCut) continue;
    byMonth.set(m, [...(byMonth.get(m) ?? []), s]);
  }
  for (const [month, ws] of [...byMonth].sort((a, b) => b[0].localeCompare(a[0]))) {
    if (calls >= MAX_PER_RUN) break;
    const live = ws.filter((w) => w.count > 0);
    const id = `month:${month}`;
    if (live.length === 0) {
      if (existing.has(id)) await db.run(`DELETE FROM ai_memory WHERE id = ?`, id);
      continue;
    }
    const weekly = live.map((w) => existing.get(`week:${w.start}`));
    if (weekly.some((w, i) => !w || w.fingerprint !== live[i]!.fingerprint)) continue; // 週の要約待ち
    const fingerprint = live.map((w) => `${w.start}=${w.fingerprint}`).join('|');
    if (existing.get(id)?.fingerprint === fingerprint) continue;
    const items = weekly.map((w) => `<digest period="${w!.period_start}〜${addDays(w!.period_end, -1)}" memos="${w!.memo_count}">\n${escapeData(w!.summary)}\n</digest>`);
    const { summary, topics } = await summarize(ai, 'month', `${month}（${tz}）`, items);
    calls++;
    if (!summary) continue;
    const next = addDays(`${month}-28`, 7).slice(0, 7);
    await db.batch([
      upsertMemory({
        id,
        level: 'month',
        period_start: `${month}-01`,
        period_end: `${next}-01`,
        summary,
        topics,
        memo_count: live.reduce((a, w) => a + w.count, 0),
        fingerprint,
        model: ai.model,
        updated_at: now.toISOString(),
      }),
    ]);
    made++;
  }
  return made;
}

/**
 * 提案生成に渡す長期記憶。
 * - MONTH_AFTER_DAYS 日以内の週は週の要約（新しい順に CONTEXT_WEEKS 件）
 * - それより古い期間は月の要約（新しい順に CONTEXT_MONTHS 件）。月の要約がまだ無い月は週の要約で代用
 */
export async function loadMemoryContext(db: Db, settings: UserSettings, now: Date): Promise<MemoryRow[]> {
  const today = localDay(now, settings.timezone);
  const monthCut = addDays(today, -MONTH_AFTER_DAYS).slice(0, 7);
  const weeks = await db.all<MemoryRow>(
    `SELECT * FROM ai_memory WHERE level = 'week' AND substr(period_start, 1, 7) >= ? ORDER BY period_start DESC LIMIT ?`,
    monthCut,
    CONTEXT_WEEKS,
  );
  const months = await db.all<MemoryRow>(
    `SELECT * FROM ai_memory WHERE level = 'month' ORDER BY period_start DESC LIMIT ?`,
    CONTEXT_MONTHS,
  );
  const covered = new Set(months.map((m) => m.period_start.slice(0, 7)));
  const fallback = await db.all<MemoryRow>(
    `SELECT * FROM ai_memory WHERE level = 'week' AND substr(period_start, 1, 7) < ? ORDER BY period_start DESC LIMIT ?`,
    monthCut,
    CONTEXT_WEEKS,
  );
  return [...weeks, ...months, ...fallback.filter((w) => !covered.has(w.period_start.slice(0, 7)))].sort((a, b) =>
    b.period_start.localeCompare(a.period_start),
  );
}

export function memoryLines(rows: MemoryRow[]): string[] {
  if (rows.length === 0) return ['（まだ要約された期間はありません）'];
  return rows.map((r) => {
    const topics = (JSON.parse(r.topics) as string[]).join('、');
    const label = r.level === 'week' ? '週' : '月';
    return `<digest level="${label}" period="${r.period_start}〜${addDays(r.period_end, -1)}" memos="${r.memo_count}"${topics ? ` topics="${escapeData(topics).replace(/"/g, "'")}"` : ''}>\n${escapeData(r.summary)}\n</digest>`;
  });
}
