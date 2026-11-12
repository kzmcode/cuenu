// 表示用の日時整形。保存は UTC、表示は settings.timezone。

export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions, key: string): Intl.DateTimeFormat {
  const k = tz + '|' + key;
  let f = fmtCache.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('ja-JP', { ...opts, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat('ja-JP', { ...opts, timeZone: DEFAULT_TIMEZONE });
    }
    fmtCache.set(k, f);
  }
  return f;
}

function parts(d: Date, tz: string) {
  const p = fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, 'parts').formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** 一覧用の短い日時。今年なら年を省略 */
export function formatMemoDate(iso: string, tz: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const a = parts(d, tz);
  const b = parts(now, tz);
  const hm = `${String(a.h).padStart(2, '0')}:${String(a.min).padStart(2, '0')}`;
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `今日 ${hm}`;
  if (a.y === b.y) return `${a.m}月${a.d}日 ${hm}`;
  return `${a.y}年${a.m}月${a.d}日 ${hm}`;
}

export function formatFullDate(iso: string, tz: string = DEFAULT_TIMEZONE): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return fmt(tz, { dateStyle: 'medium', timeStyle: 'short' }, 'full').format(d);
}

/** tz での日付 'YYYY-MM-DD' の 0:00 を UTC ISO に変換 */
export function zonedDayStartToUtc(date: string, tz: string = DEFAULT_TIMEZONE): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // tz のオフセットを求めて補正（DST 境界でも 2 回の反復で十分）
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(t), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    t = guess - (asUtc - t);
  }
  return new Date(t).toISOString();
}

/** 'YYYY-MM-DD' の翌日 */
export function nextDay(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** UTC ISO を tz の日付キー 'YYYY-MM-DD' に */
export function dayKey(iso: string, tz: string = DEFAULT_TIMEZONE): string {
  const p = parts(new Date(iso), tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' を「11月4日（火）」形式に */
export function formatDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const w = '日月火水木金土'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}月${d}日（${w}）`;
}
