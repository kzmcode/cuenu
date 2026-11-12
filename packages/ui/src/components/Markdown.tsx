import { lazy, memo, Suspense } from 'react';

// Markdown 描画ライブラリは遅延読み込み（入力欄の表示を待たせない）。読み込み中はプレーンテキストで表示
const MarkdownImpl = lazy(() => import('./MarkdownImpl'));

/** untrusted: AI 投稿など第三者由来の本文。リンクの実際の遷移先を常に表示する */
export const Markdown = memo(function Markdown({ source, untrusted = false }: { source: string; untrusted?: boolean }) {
  return (
    <Suspense fallback={<div className="cu-md cu-md-plain">{source}</div>}>
      <MarkdownImpl source={source} untrusted={untrusted} />
    </Suspense>
  );
});
