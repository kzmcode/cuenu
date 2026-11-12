import { ImageIcon, ScreenshotIcon } from './Icons';
import type { LocalMemo } from '@cuenu/core';
import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type DragEvent } from 'react';
import { useAutoResize } from '../hooks';
import { usePlatform } from '../platform';

export interface ComposerProps {
  /** 下書きキー: 'main' | 'quick' | `reply:${parentId}` */
  draftKey: string;
  parentId?: string | null;
  placeholder?: string;
  submitLabel?: string;
  /** 画像要約メモの添付を許可（返信では既定 false） */
  allowImage?: boolean;
  autoFocus?: boolean;
  /** 値が変わるたびに入力欄へフォーカス */
  focusSignal?: number;
  onPosted?(memo: LocalMemo): void;
  /** Esc（IME 変換中は無視）。下書きを保存してから呼ぶ */
  onEscape?(): void;
  /** 入力欄のアクセシブル名 */
  label?: string;
  className?: string;
}

const DRAFT_DELAY_MS = 400;

const isMacLike = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** IME 変換中のキー入力か */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export function Composer({
  draftKey,
  parentId = null,
  placeholder = 'いま考えていること',
  submitLabel = '投稿',
  allowImage = true,
  autoFocus,
  focusSignal,
  onPosted,
  onEscape,
  label = 'メモを入力',
  className,
}: ComposerProps) {
  const { repo, captureScreen } = usePlatform();
  const [dragOver, setDragOver] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const dragDepth = useRef(0);
  const [body, setBody] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef(body);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintId = useId();
  const errId = useId();
  bodyRef.current = body;

  // 下書き復元（入力が始まっていれば上書きしない）
  const keyRef = useRef(draftKey);
  useEffect(() => {
    let alive = true;
    if (keyRef.current !== draftKey) {
      // 下書きキーが変わったときだけリセット（初回は入力済みの文字を消さない）
      keyRef.current = draftKey;
      dirtyRef.current = false;
      setBody('');
    }
    repo
      .getDraft(draftKey)
      .then((d) => {
        if (alive && d && !dirtyRef.current) setBody(d.body);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo, draftKey]);

  const flushDraft = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return Promise.resolve();
    const b = bodyRef.current;
    const p = b.trim() ? repo.setDraft(draftKey, b) : repo.clearDraft(draftKey);
    return p.catch(() => {});
  }, [repo, draftKey]);

  // 画面を閉じる・隠すときに退避（自動投稿はしない）
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flushDraft();
    };
    const onPageHide = () => void flushDraft();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      void flushDraft();
    };
  }, [flushDraft]);

  useEffect(() => {
    if (focusSignal !== undefined) ref.current?.focus();
  }, [focusSignal]);

  useAutoResize(ref, body);

  useEffect(() => {
    if (!image) {
      setPreviewUrl(null);
      return;
    }
    if (typeof URL.createObjectURL !== 'function') return;
    const u = URL.createObjectURL(image);
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [image]);

  const clearImage = () => {
    setImage(null);
    // 同じファイルを選び直したときも onChange が発火するように
    if (fileRef.current) fileRef.current.value = '';
  };

  const change = (v: string) => {
    dirtyRef.current = true;
    setBody(v);
    setError(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flushDraft(), DRAFT_DELAY_MS);
  };

  const canSubmit = !posting && (body.trim().length > 0 || image !== null);

  const submit = async () => {
    if (!canSubmit) return;
    setPosting(true);
    setError(null);
    const text = body;
    try {
      const memo = await repo.create({ body: text, parentId, image });
      // 投稿中に追記された分は残す
      const rest = bodyRef.current === text ? '' : bodyRef.current;
      dirtyRef.current = true;
      setBody(rest);
      bodyRef.current = rest;
      clearImage();
      await flushDraft();
      onPosted?.(memo);
    } catch (e) {
      setError(`保存できませんでした。本文は残っています。（${e instanceof Error ? e.message : String(e)}）`);
    } finally {
      setPosting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      dirtyRef.current = true;
      void flushDraft().then(() => onEscape());
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!allowImage) return;
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    setImage(file);
  };

  const shortcut = isMacLike() ? '⌘Enter' : 'Ctrl+Enter';

  // 画像ファイルのドラッグ&ドロップ（最初の 1 枚を画像要約メモとして添付）
  const hasFiles = (e: DragEvent<HTMLFormElement>) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const dropHandlers = allowImage
    ? {
        onDragEnter: (e: DragEvent<HTMLFormElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDragOver(true);
        },
        onDragOver: (e: DragEvent<HTMLFormElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        },
        onDrop: (e: DragEvent<HTMLFormElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
          if (file) {
            setImage(file);
            setError(null);
          } else {
            setError('画像ファイルをドロップしてください');
          }
          ref.current?.focus();
        },
      }
    : {};

  const capture = async () => {
    if (!captureScreen || capturing) return;
    setCapturing(true);
    setError(null);
    try {
      const blob = await captureScreen();
      if (blob && blob.size > 0) setImage(new File([blob], `screenshot-${Date.now()}.png`, { type: blob.type || 'image/png' }));
    } catch (e) {
      setError(`スクリーンショットを取り込めませんでした（${e instanceof Error ? e.message : String(e)}）`);
    } finally {
      setCapturing(false);
      ref.current?.focus();
    }
  };

  return (
    <form
      className={'cu-composer' + (className ? ' ' + className : '') + (dragOver ? ' cu-composer--drop' : '')}
      {...dropHandlers}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={ref}
        className="cu-composer-input"
        value={body}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={error ? `${hintId} ${errId}` : hintId}
        aria-invalid={error ? true : undefined}
        autoFocus={autoFocus}
        rows={parentId ? 1 : 2}
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {image && (
        <div className="cu-composer-image">
          {previewUrl && <img src={previewUrl} alt="" className="cu-composer-thumb" />}
          <span>画像（投稿後に要約）: {image.name || '貼り付け画像'}</span>
          <button type="button" className="cu-btn-text" onClick={clearImage}>
            画像を外す
          </button>
        </div>
      )}
      {error && (
        <p id={errId} className="cu-error" role="alert">
          {error}
        </p>
      )}
      <div className="cu-composer-bar">
        {allowImage && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              data-testid="composer-file"
              onChange={(e) => setImage(e.target.files?.[0] ?? null)}
            />
            <button type="button" className="cu-btn-text cu-icon-action" aria-label="画像" title="画像から要約メモを作る" onClick={() => fileRef.current?.click()}>
              <ImageIcon size={20} />
            </button>
            {captureScreen && (
              <button
                type="button"
                className="cu-btn-text cu-icon-action"
                aria-label="スクリーンショット"
                title="画面の一部を撮影して添付"
                disabled={capturing}
                onClick={() => void capture()}
              >
                <ScreenshotIcon size={20} />
              </button>
            )}
          </>
        )}
        {dragOver && (
          <span className="cu-drop-hint" aria-hidden="true">
            ここに画像をドロップ
          </span>
        )}
        <span id={hintId} className="cu-composer-hint">
          {shortcut} で{submitLabel}
        </span>
        <button type="submit" className="cu-btn-primary" disabled={!canSubmit}>
          {posting ? '保存中…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
