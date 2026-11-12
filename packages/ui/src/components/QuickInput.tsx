import type { LocalMemo } from '@cuenu/core';
import { useState } from 'react';
import { Composer } from './Composer';

export interface QuickInputViewProps {
  draftKey?: string;
  onPosted?(memo: LocalMemo): void;
  onDismiss?(): void;
  focusSignal?: number;
}

/** Mac クイック入力用の最小画面（Provider 内で使う。単体利用は CuenuQuickInput） */
export function QuickInputView({ draftKey = 'quick', onPosted, onDismiss, focusSignal }: QuickInputViewProps) {
  const [saved, setSaved] = useState(false);
  return (
    <main className="cu-quick">
      {/* 装飾なしウィンドウのため、上端をドラッグ領域にする（Tauri の data-tauri-drag-region） */}
      <header className="cu-quick-head" data-tauri-drag-region>
        <span className="cu-quick-title" data-tauri-drag-region>
          Cuenu
        </span>
        <span className="cu-quick-hint" data-tauri-drag-region>
          Esc で閉じる
        </span>
      </header>
      <Composer
        draftKey={draftKey}
        autoFocus
        focusSignal={focusSignal}
        onPosted={(m) => {
          setSaved(true);
          onPosted?.(m);
        }}
        onEscape={() => onDismiss?.()}
      />
      <p className="cu-sr-only" role="status">
        {saved ? '保存しました' : ''}
      </p>
    </main>
  );
}
