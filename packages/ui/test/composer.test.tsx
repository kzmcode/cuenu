import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/components/Composer';
import { createMockRepository } from '../src/mockRepository';
import { renderWithPlatform } from './helpers';

const input = () => screen.getByRole('textbox', { name: 'メモを入力' }) as HTMLTextAreaElement;

describe('Composer', () => {
  it('Enter は改行で投稿しない', async () => {
    const onPosted = vi.fn();
    renderWithPlatform(<Composer draftKey="main" onPosted={onPosted} />);
    await userEvent.type(input(), 'a{Enter}b');
    expect(input().value).toBe('a\nb');
    expect(onPosted).not.toHaveBeenCalled();
  });

  it('⌘Enter / Ctrl+Enter で投稿し、入力欄を空にする', async () => {
    const onPosted = vi.fn();
    const { repo } = renderWithPlatform(<Composer draftKey="main" onPosted={onPosted} />);
    await userEvent.type(input(), 'メモ1');
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
    expect(onPosted.mock.calls[0]![0].body).toBe('メモ1');
    expect(input().value).toBe('');
    await userEvent.type(input(), 'メモ2');
    fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onPosted).toHaveBeenCalledTimes(2));
    expect((await repo.timeline()).items.map((m) => m.body)).toEqual(['メモ2', 'メモ1']);
  });

  it('IME 変換中（isComposing / keyCode 229）は投稿しない', async () => {
    const onPosted = vi.fn();
    renderWithPlatform(<Composer draftKey="main" onPosted={onPosted} />);
    fireEvent.change(input(), { target: { value: 'にほんご' } });
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true, keyCode: 229 });
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    await new Promise((r) => setTimeout(r, 20));
    expect(onPosted).not.toHaveBeenCalled();
    expect(input().value).toBe('にほんご');
  });

  it('空白のみは投稿できない', async () => {
    const onPosted = vi.fn();
    renderWithPlatform(<Composer draftKey="main" onPosted={onPosted} />);
    fireEvent.change(input(), { target: { value: '  \n ' } });
    expect(screen.getByRole('button', { name: '投稿' })).toBeDisabled();
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(onPosted).not.toHaveBeenCalled();
  });

  it('投稿ボタンで投稿', async () => {
    const onPosted = vi.fn();
    renderWithPlatform(<Composer draftKey="main" onPosted={onPosted} />);
    await userEvent.type(input(), 'スマホから');
    await userEvent.click(screen.getByRole('button', { name: '投稿' }));
    await waitFor(() => expect(onPosted).toHaveBeenCalled());
  });

  it('保存失敗時は本文を保持してエラー表示', async () => {
    const repo = createMockRepository();
    repo.failNextCreate('quota');
    const onPosted = vi.fn();
    renderWithPlatform(<Composer draftKey="main" onPosted={onPosted} />, { repo });
    await userEvent.type(input(), '失いたくない');
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('本文は残っています');
    expect(input().value).toBe('失いたくない');
    expect(onPosted).not.toHaveBeenCalled();
  });

  it('下書きを自動退避し、再表示で復元する', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const repo = createMockRepository();
    const first = renderWithPlatform(<Composer draftKey="main" />, { repo });
    fireEvent.change(input(), { target: { value: '書きかけ' } });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect((await repo.getDraft('main'))?.body).toBe('書きかけ');
    first.unmount();
    vi.useRealTimers();
    renderWithPlatform(<Composer draftKey="main" />, { repo });
    await waitFor(() => expect(input().value).toBe('書きかけ'));
  });

  it('アンマウント時に未保存の下書きを退避', async () => {
    const repo = createMockRepository();
    const r = renderWithPlatform(<Composer draftKey="main" />, { repo });
    fireEvent.change(input(), { target: { value: 'すぐ閉じた' } });
    r.unmount();
    await waitFor(async () => expect((await repo.getDraft('main'))?.body).toBe('すぐ閉じた'));
  });

  it('画像の貼り付けで画像要約メモを作る', async () => {
    const onPosted = vi.fn();
    renderWithPlatform(<Composer draftKey="main" onPosted={onPosted} />);
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(input(), { clipboardData: { files: [file], getData: () => '' } });
    expect(await screen.findByText(/shot\.png/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '投稿' }));
    await waitFor(() => expect(onPosted).toHaveBeenCalled());
    expect(onPosted.mock.calls[0]![0].image.status).toBe('waiting');
  });

  it('画像を外すとファイル選択も空になり、同じファイルを選び直せる', async () => {
    renderWithPlatform(<Composer draftKey="main" />);
    const fileInput = screen.getByTestId('composer-file') as HTMLInputElement;
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    await userEvent.upload(fileInput, file);
    expect(await screen.findByText(/pic\.png/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '画像を外す' }));
    expect(screen.queryByText(/pic\.png/)).toBeNull();
    expect(fileInput.value).toBe('');
    await userEvent.upload(fileInput, file);
    expect(await screen.findByText(/pic\.png/)).toBeInTheDocument();
  });
});
