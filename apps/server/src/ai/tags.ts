// 自動タグの正規化（表記揺れ・重複を減らす）

const MAX_TAGS_PER_MEMO = 5;

const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

/**
 * AI が返した絵文字を検証する。絵文字1文字（書記素1つ）のみ許可し、文字・記号・複数個は null。
 * 画面ではアバター代わりに使うため、文章や URL が入り込まないようにする。
 */
export function normalizeEmoji(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 16) return null;
  const seg = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  const parts = [...seg.segment(t)];
  if (parts.length !== 1) return null;
  return EMOJI_RE.test(t) ? t : null;
}
const MAX_TAG_LEN = 24;

export function normalizeTag(raw: string): string | null {
  let t = raw.normalize('NFKC').trim();
  t = t.replace(/^[#＃]+/, '');
  t = t.replace(/^[「『（(\[【"']+|[」』）)\]】"'。、,.]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t.length > MAX_TAG_LEN) return null;
  if (/^[\d\s\p{P}]+$/u.test(t)) return null;
  return t;
}

/** 表記揺れ判定用キー（空白・記号を除去、カタカナ→ひらがな） */
export function tagKey(t: string): string {
  return t
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_・/]+/g, '')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 既存語彙の表記に寄せ、重複を除き、上限件数に切る */
export function canonicalizeTags(raw: unknown, vocabulary: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const vocab = new Map<string, string>();
  for (const v of vocabulary) {
    const k = tagKey(v);
    if (!vocab.has(k)) vocab.set(k, v);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const n = normalizeTag(r);
    if (!n) continue;
    const k = tagKey(n);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(vocab.get(k) ?? n);
    if (out.length >= MAX_TAGS_PER_MEMO) break;
  }
  return out;
}
