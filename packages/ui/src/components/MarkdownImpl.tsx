import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type HastLike = { type?: string; value?: string; children?: HastLike[] };

function textOf(node: HastLike | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

// 比較用に URL を正規化（スキーム・末尾スラッシュ・大文字小文字を無視）
function normalizeUrl(s: string): string {
  return s
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 表示用の遷移先。ホスト名があればホスト名（IDN は punycode になり同形異字を見抜ける）、なければ href そのもの */
export function linkDestinationLabel(href: string): string {
  try {
    const u = new URL(href);
    return u.host || href;
  } catch {
    return href;
  }
}

const img: Components['img'] = ({ node: _node, alt }) => (
  // 外部画像は読み込まない（追跡・漏えい防止）。代替テキストのみ表示
  <span className="cu-md-img">[画像{alt ? `: ${alt}` : ''}]</span>
);

const input: Components['input'] = ({ node: _node, ...props }) => (
  // GFM チェックボックスは表示のみ（タスク DB にしない）
  <input {...props} disabled readOnly />
);

function makeComponents(untrusted: boolean): Components {
  return {
    a({ node, href, children, ...props }) {
      // urlTransform で除去された危険な URL（空 href）はリンクにしない
      if (!href || !href.trim()) return <span className="cu-md-link-stripped">{children}</span>;
      if (!untrusted) {
        return (
          <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {children}
          </a>
        );
      }
      // AI 投稿（プロンプトインジェクションの可能性）: 実際の遷移先を必ず見せる
      const text = textOf(node as HastLike);
      const same = normalizeUrl(text) === normalizeUrl(href);
      return (
        <a
          {...props}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="cu-md-link--untrusted"
          title={href}
          data-untrusted-link=""
        >
          {children}
          {!same && <span className="cu-md-link-dest"> ({linkDestinationLabel(href)})</span>}
          <span className="cu-md-link-mark" aria-hidden="true">
            ↗
          </span>
        </a>
      );
    },
    img,
    input,
  };
}

const trustedComponents = makeComponents(false);
const untrustedComponents = makeComponents(true);

// 生 HTML は描画しない（skipHtml）。URL は react-markdown 既定の urlTransform で javascript: 等を除去。
const MarkdownImpl = memo(function MarkdownImpl({ source, untrusted = false }: { source: string; untrusted?: boolean }) {
  return (
    <div className="cu-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={untrusted ? untrustedComponents : trustedComponents}>
        {source}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownImpl;
