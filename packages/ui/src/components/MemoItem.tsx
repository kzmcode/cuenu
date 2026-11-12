import type { AiPostKind, MemoWithMeta } from '@cuenu/core';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNav, usePrefs, useToast } from '../context';
import { formatFullDate, formatMemoDate } from '../format';
import { useAutoResize } from '../hooks';
import { usePlatform } from '../platform';
import { isImeComposing } from './Composer';
import { AlertIcon, HeartIcon, CloudUpIcon, ConflictIcon, ImageIcon, MoreIcon, PenIcon, ReplyIcon, SparkleIcon } from './Icons';
import { Markdown } from './Markdown';

/** 省略表示の閾値（仮置き。docs/ui.md） */
const COLLAPSE_LINES = 8;
const COLLAPSE_CHARS = 400;

export function isLongBody(body: string): boolean {
  return body.length > COLLAPSE_CHARS || body.split('\n').length > COLLAPSE_LINES;
}

export const AI_KIND_LABEL: Record<AiPostKind, string> = {
  action: '行動の提案',
  related: '関連メモ',
  reflection: '振り返り',
};

export type MemoItemMode = 'timeline' | 'thread-parent' | 'reply' | 'search';

export interface MemoItemProps {
  memo: MemoWithMeta;
  mode?: MemoItemMode;
  /** 削除後に呼ぶ（スレッド親の削除で戻る等） */
  onRemoved?(memo: MemoWithMeta): void;
}

export function MemoItem({ memo, mode = 'timeline', onRemoved }: MemoItemProps) {
  const { repo, deviceId } = usePlatform();
  const nav = useNav();
  const toast = useToast();
  const { timezone } = usePrefs();
  const [fits, setFits] = useState(false);
  const long = isLongBody(memo.body) && !fits;
  const [expanded, setExpanded] = useState(mode === 'thread-parent');
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const bodyId = useId();
  const isAi = memo.author === 'ai';
  const isTop = memo.parentId === null;

  const run = async (fn: () => Promise<unknown>, failMsg: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(`${failMsg}（${e instanceof Error ? e.message : String(e)}）`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next) {
      // 折りたたみで投稿の先頭が画面外に出たら、その投稿の位置に戻す
      requestAnimationFrame(() => {
        const el = rootRef.current;
        if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView?.({ block: 'start' });
      });
    }
  };

  const remove = async () => {
    const ok = await run(() => repo.remove(memo.id), '削除できませんでした');
    setConfirmDelete(false);
    if (!ok) return;
    onRemoved?.(memo);
    toast.show(isAi ? 'AIの投稿を非表示にしました' : '削除しました', {
      label: '取り消す',
      run: () => void repo.undoRemove(memo.id).catch(() => toast.show('取り消せませんでした（同期済みの可能性があります）')),
    });
  };

  const openThread = () => nav.openThread(isTop ? memo.id : memo.parentId!);
  const collapsed = long && !expanded && editing === null;

  // 実寸で収まる場合は省略しない（レイアウトのない環境では文字数・行数の判定のみ）
  useLayoutEffect(() => {
    setFits(false);
  }, [memo.body]);
  useLayoutEffect(() => {
    const el = document.getElementById(bodyId);
    if (collapsed && el && el.scrollHeight > 0 && el.scrollHeight <= el.clientHeight + 2) setFits(true);
  }, [collapsed, bodyId, memo.body]);

  return (
    <article ref={rootRef} className={`cu-memo cu-memo--${mode}`} aria-labelledby={bodyId + '-meta'} data-memo-id={memo.id}>
      {/* アバター代わり: AI は丸付きの ✦、自分のメモは AI が選んだ絵文字（未付与の間はペン/画像の線画） */}
      {isAi ? (
        <div className="cu-avatar cu-avatar--ai" aria-hidden="true">
          <SparkleIcon size={18} />
        </div>
      ) : (
        <div className={'cu-avatar cu-avatar--plain' + (memo.emoji ? ' cu-avatar--emoji' : '')} aria-hidden="true">
          {memo.emoji ? memo.emoji : memo.image ? <ImageIcon size={20} /> : <PenIcon size={19} />}
        </div>
      )}
      <div className="cu-memo-content">
      <header className="cu-memo-meta" id={bodyId + '-meta'}>
        {isAi && (
          <span className="cu-ai-label">
            AI{memo.ai ? ` · ${AI_KIND_LABEL[memo.ai.kind]}` : ''}
          </span>
        )}
        {mode === 'search' && !isTop && <span className="cu-badge">返信</span>}
        <time dateTime={memo.createdAt} title={formatFullDate(memo.createdAt, timezone)}>
          {formatMemoDate(memo.createdAt, timezone)}
        </time>
        {memo.editedAt && (
          <span className="cu-meta-note" title={`更新: ${formatFullDate(memo.editedAt, timezone)}`}>
            編集済み
          </span>
        )}
        <SyncBadge memo={memo} />
      </header>

      {editing !== null ? (
        <EditForm
          memoId={memo.id}
          initial={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            const ok = await run(
              () => (memo.syncState === 'conflict' ? repo.resolveConflict(memo.id, { body }) : repo.updateBody(memo.id, body)),
              '保存できませんでした。編集内容は残っています',
            );
            if (ok) {
              setEditing(null);
              await repo.clearDraft(`edit:${memo.id}`).catch(() => {});
            }
          }}
        />
      ) : (
        <>
          <div id={bodyId} className={'cu-memo-body' + (collapsed ? ' cu-memo-body--collapsed' : '')}>
            {memo.body.trim() ? <Markdown source={memo.body} untrusted={isAi} /> : memo.image ? null : <p className="cu-meta-note">（本文なし）</p>}
          </div>
          {long && (
            <button type="button" className="cu-btn-text cu-expand" aria-expanded={expanded} aria-controls={bodyId} onClick={toggle}>
              {expanded ? '折りたたむ' : '続きを表示'}
            </button>
          )}
        </>
      )}

      {memo.image && <ImageSummaryPanel memo={memo} deviceId={deviceId ?? null} run={run} busy={busy} />}
      {memo.syncState === 'conflict' && memo.conflict && editing === null && (
        <ConflictPanel memo={memo} busy={busy} run={run} onMerge={(b) => setEditing(b)} />
      )}
      {memo.syncState === 'error' && memo.syncError && <p className="cu-error">同期エラー: {memo.syncError}</p>}

      {memo.tags.length > 0 && (
        <p className="cu-memo-tags">
          {memo.tags.map((t) => (
            <button key={t} type="button" className="cu-tag" onClick={() => nav.openSearch({ tags: [t] })}>
              #{t}
            </button>
          ))}
        </p>
      )}

      {error && (
        <p className="cu-error" role="alert">
          {error}
        </p>
      )}

      {confirmDelete ? (
        <div className="cu-confirm" role="alertdialog" aria-label="削除の確認">
          <p>
            {isAi ? 'このAIの投稿を非表示にしますか？' : 'このメモを削除しますか？'}
            {isTop && memo.replyCount > 0 && <strong> 返信 {memo.replyCount} 件も一緒に削除されます。</strong>}
          </p>
          <div className="cu-row">
            <button type="button" className="cu-btn-danger" disabled={busy} onClick={() => void remove()} autoFocus>
              {isAi ? '非表示にする' : '削除する'}
            </button>
            <button type="button" className="cu-btn" onClick={() => setConfirmDelete(false)}>
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        editing === null && (
          <footer className="cu-memo-actions">
            {isTop && mode !== 'thread-parent' && (
              <button
                type="button"
                className="cu-btn-text cu-icon-action"
                aria-label={`返信${memo.replyCount > 0 ? ` ${memo.replyCount}` : ''}`}
                title="返信"
                onClick={openThread}
              >
                <ReplyIcon size={18} />
                {memo.replyCount > 0 && <span className="cu-icon-count">{memo.replyCount}</span>}
              </button>
            )}
            {isAi && <LikeButton liked={!!memo.liked} onToggle={() => void run(() => repo.setLiked(memo.id, !memo.liked), 'いいねできませんでした')} />}
            {mode === 'search' && !isTop && (
              <button type="button" className="cu-btn-text" onClick={openThread}>
                スレッドを開く
              </button>
            )}
            <MoreMenu
              items={[
                ...(isAi && memo.ai
                  ? memo.ai.sourceIds.map((id, i, all) => ({
                      label: all.length > 1 ? `参照元のメモ ${i + 1} を開く` : '参照元のメモを開く',
                      run: () => nav.openMemo(id),
                    }))
                  : []),
                ...(!isAi
                  ? [
                      {
                        label: '編集',
                        run: async () => {
                          const d = await repo.getDraft(`edit:${memo.id}`).catch(() => null);
                          setEditing(d?.body ?? memo.body);
                        },
                      },
                    ]
                  : []),
                { label: isAi ? '非表示' : '削除', danger: true, run: () => setConfirmDelete(true) },
              ]}
            />
          </footer>
        )
      )}
      </div>
    </article>
  );
}

/** いいね: 付けた瞬間にハートが弾み、小さな粒が広がる（取り消しは静かに戻る） */
function LikeButton({ liked, onToggle }: { liked: boolean; onToggle(): void }) {
  const [pop, setPop] = useState(0);
  useEffect(() => {
    if (!pop) return;
    const t = setTimeout(() => setPop(0), 700);
    return () => clearTimeout(t);
  }, [pop]);
  return (
    <button
      type="button"
      className={'cu-btn-text cu-icon-action cu-like' + (liked ? ' cu-like--on' : '') + (pop ? ' cu-like--pop' : '')}
      aria-label="いいね"
      aria-pressed={liked}
      title={liked ? 'いいねを取り消す' : 'いいね（今後の提案の参考になります）'}
      onClick={() => {
        if (!liked) setPop(Date.now());
        navigator.vibrate?.(8);
        onToggle();
      }}
    >
      <span className="cu-like-icon" key={pop}>
        <HeartIcon size={18} filled={liked} />
      </span>
      {pop ? (
        <span className="cu-like-burst" key={`b${pop}`} aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} style={{ ['--a' as string]: `${i * 45}deg` }} />
          ))}
        </span>
      ) : null}
    </button>
  );
}

interface MenuItem {
  label: string;
  danger?: boolean;
  run(): unknown;
}

/** 投稿ごとの「…」メニュー（編集・削除・参照元など頻度の低い操作をまとめる） */
function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    wrapRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div className="cu-more" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="cu-btn-text cu-icon-action cu-more-btn"
        title="その他の操作"
        aria-label="その他の操作"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon size={18} />
      </button>
      {open && (
        <div className="cu-more-menu" role="menu" id={menuId}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={'cu-more-item' + (it.danger ? ' cu-more-item--danger' : '')}
              onClick={() => {
                setOpen(false);
                void it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SyncBadge({ memo }: { memo: MemoWithMeta }) {
  // 文字の代わりにアイコンで示す（形が異なるので色だけに頼らない。名前は aria-label/title）
  const badge =
    memo.syncState === 'pending'
      ? { label: '同期待ち', icon: <CloudUpIcon size={15} />, cls: '' }
      : memo.syncState === 'error'
        ? { label: '同期失敗', icon: <AlertIcon size={15} />, cls: ' cu-status-icon--error' }
        : memo.syncState === 'conflict'
          ? { label: '競合あり', icon: <ConflictIcon size={15} />, cls: ' cu-status-icon--error' }
          : null;
  if (!badge) return null;
  return (
    <span className={'cu-status-icon' + badge.cls} role="img" aria-label={badge.label} title={badge.label}>
      {badge.icon}
    </span>
  );
}

function EditForm({
  memoId,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  memoId: string;
  initial: string;
  busy: boolean;
  onSave(body: string): void;
  onCancel(): void;
}) {
  const { repo } = usePlatform();
  const [body, setBody] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useAutoResize(ref, body);
  useEffect(() => {
    const t = setTimeout(() => void repo.setDraft(`edit:${memoId}`, body).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [repo, memoId, body]);
  const cancel = () => {
    void repo.clearDraft(`edit:${memoId}`).catch(() => {});
    onCancel();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (body.trim()) onSave(body);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
  return (
    <form
      className="cu-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim()) onSave(body);
      }}
    >
      <textarea ref={ref} className="cu-composer-input" aria-label="メモを編集" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onKeyDown} />
      <div className="cu-row">
        <button type="submit" className="cu-btn-primary" disabled={busy || !body.trim()}>
          保存
        </button>
        <button type="button" className="cu-btn" onClick={cancel}>
          キャンセル
        </button>
      </div>
    </form>
  );
}

type Runner = (fn: () => Promise<unknown>, failMsg: string) => Promise<boolean>;

function ImageSummaryPanel({ memo, deviceId, run, busy }: { memo: MemoWithMeta; deviceId: string | null; run: Runner; busy: boolean }) {
  const { repo } = usePlatform();
  const img = memo.image!;
  const otherDevice = deviceId !== null && img.originDeviceId !== deviceId;
  const retry = () => void run(() => repo.retryImageSummary(memo.id), '再試行できませんでした');
  const cancel = () => void run(() => repo.cancelImageSummary(memo.id), 'キャンセルできませんでした');
  return (
    <div className="cu-image-state" role="status">
      {(img.status === 'waiting' || img.status === 'processing') && (
        <>
          <p>
            <span className="cu-status">◷ {img.status === 'waiting' ? '画像要約待ち' : '画像を要約中…'}</span>
            {otherDevice && <span className="cu-meta-note"> 元の端末で画像が送信されるまで要約できません</span>}
          </p>
          {!otherDevice && (
            <div className="cu-row">
              <button type="button" className="cu-btn-text" disabled={busy} onClick={cancel}>
                要約をキャンセル
              </button>
            </div>
          )}
        </>
      )}
      {img.status === 'failed' && (
        <>
          <p className="cu-error">⚠ 画像要約に失敗しました{img.error ? `: ${img.error}` : ''}（画像は端末内に残っています）</p>
          {!otherDevice && (
            <div className="cu-row">
              <button type="button" className="cu-btn" disabled={busy} onClick={retry}>
                再試行
              </button>
              <button type="button" className="cu-btn" disabled={busy} onClick={cancel}>
                キャンセル（画像を破棄）
              </button>
            </div>
          )}
        </>
      )}
      {img.status === 'cancelled' && <p className="cu-meta-note">画像要約はキャンセルされました</p>}
      {img.status === 'done' && img.summary && !img.applied && (
        <>
          <p className="cu-meta-note">画像の要約（本文が編集されていたため自動反映していません）:</p>
          <blockquote className="cu-summary">{img.summary}</blockquote>
          <button type="button" className="cu-btn" disabled={busy} onClick={() => void run(() => repo.applyImageSummary(memo.id), '反映できませんでした')}>
            本文に反映
          </button>
        </>
      )}
    </div>
  );
}

function ConflictPanel({ memo, busy, run, onMerge }: { memo: MemoWithMeta; busy: boolean; run: Runner; onMerge(body: string): void }) {
  const { repo } = usePlatform();
  const c = memo.conflict!;
  return (
    <div className="cu-conflict" role="group" aria-label="競合の解決">
      <p>
        <strong>⚠ 別の端末でも編集されました。</strong>どちらを残すか選んでください（選ぶまで両方保持されます）。
      </p>
      <div className="cu-conflict-version">
        <p className="cu-meta-note">この端末の版</p>
        <pre className="cu-conflict-text">{c.localBody}</pre>
      </div>
      <div className="cu-conflict-version">
        <p className="cu-meta-note">サーバーの版（{c.server.deletedAt ? '削除済み' : `版 ${c.server.version}`}）</p>
        <pre className="cu-conflict-text">{c.server.body}</pre>
      </div>
      <div className="cu-row">
        <button type="button" className="cu-btn" disabled={busy} onClick={() => void run(() => repo.resolveConflict(memo.id, 'keep-local'), '解決できませんでした')}>
          この端末の版を残す
        </button>
        <button type="button" className="cu-btn" disabled={busy} onClick={() => void run(() => repo.resolveConflict(memo.id, 'keep-server'), '解決できませんでした')}>
          サーバーの版を残す
        </button>
        <button type="button" className="cu-btn" disabled={busy} onClick={() => onMerge(`${c.localBody}\n\n---\n\n${c.server.body}`)}>
          結合して編集
        </button>
      </div>
    </div>
  );
}
