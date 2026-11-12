import { BackIcon, ReplyIcon } from './Icons';
import type { MemoWithMeta } from '@cuenu/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNav } from '../context';
import { useRepoEvents } from '../hooks';
import { usePlatform } from '../platform';
import { Composer } from './Composer';
import { MemoItem } from './MemoItem';

export function Thread({ threadId, onBack }: { threadId: string; onBack(): void }) {
  const { repo } = usePlatform();
  const nav = useNav();
  const [parent, setParent] = useState<MemoWithMeta | null | undefined>(undefined);
  const [replies, setReplies] = useState<MemoWithMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 更新通知が続いたとき、後から始めた読み込みの結果だけを反映する（古い結果で上書きしない）
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const m = await repo.get(threadId);
      if (id !== reqId.current) return;
      if (m && m.parentId) {
        nav.openThread(m.parentId); // 返信 ID で開かれた場合は親スレッドへ
        return;
      }
      const visible = m && !m.deletedAt ? m : null;
      const rs = visible ? (await repo.replies(threadId)).filter((r) => !r.deletedAt) : [];
      if (id !== reqId.current) return;
      setParent(visible);
      setReplies(rs);
      setError(null);
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [repo, threadId, nav]);

  useEffect(() => {
    setParent(undefined);
    setReplies([]);
    void load();
  }, [load]);

  useRepoEvents((e) => {
    if (e.type === 'memo-changed') void load();
  });

  return (
    <section className="cu-thread" aria-label="スレッド">
      <div className="cu-view-head">
        <button type="button" className="cu-btn-text cu-icon-action cu-back-btn" aria-label="戻る" title="戻る" onClick={onBack}>
          <BackIcon size={20} />
        </button>
        <h2 className="cu-view-title">スレッド</h2>
      </div>
      {error && (
        <p className="cu-error" role="alert">
          読み込めませんでした: {error}
        </p>
      )}
      {parent === undefined && !error && <p className="cu-meta-note">読み込み中…</p>}
      {parent === null && <p className="cu-empty">このメモは削除されたか、この端末にまだありません。</p>}
      {parent && (
        <>
          {/* 親→返信→返信入力を、アイコン間の縦線でつながった1本の会話として表示する */}
          <div className="cu-thread-flow">
            <div className="cu-thread-node">
              <MemoItem memo={parent} mode="thread-parent" onRemoved={onBack} />
            </div>
            {replies.length > 0 && (
              <div className="cu-replies" aria-label={`返信 ${replies.length} 件`} role="list">
                {replies.map((r) => (
                  <div role="listitem" className="cu-thread-node cu-thread-node--reply" key={r.id}>
                    <MemoItem memo={r} mode="reply" />
                  </div>
                ))}
              </div>
            )}
            <div className="cu-thread-node cu-thread-node--compose">
              <div className="cu-avatar cu-avatar--compose" aria-hidden="true">
                <ReplyIcon size={15} />
              </div>
              <Composer
                draftKey={`reply:${parent.id}`}
                parentId={parent.id}
                placeholder="返信を書く"
                submitLabel="返信"
                label="返信を入力"
                allowImage={false}
                className="cu-reply-composer"
              />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
