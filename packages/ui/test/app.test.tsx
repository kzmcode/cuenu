import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CuenuApp, CuenuQuickInput } from '../src/App';
import { createMockRepository } from '../src/mockRepository';
import type { CuenuPlatform } from '../src/platform';

const t = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString();
const mainInput = () => screen.getByRole('textbox', { name: 'メモを入力' }) as HTMLTextAreaElement;

describe('CuenuApp', () => {
  it('起動直後に入力欄があり、タイムライン取得を待たない', () => {
    const repo = createMockRepository();
    repo.timeline = () => new Promise(() => {}); // 永遠に返らない
    render(<CuenuApp platform={{ repo }} />);
    expect(mainInput()).toBeInTheDocument();
  });

  it('テーマを切り替えても入力中の本文を保持', async () => {
    render(<CuenuApp platform={{ repo: createMockRepository() }} />);
    await userEvent.type(mainInput(), '書きかけの本文');
    await userEvent.click(screen.getByRole('button', { name: '設定' }));
    await userEvent.click(screen.getByRole('radio', { name: 'ダーク' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('cuenu.theme')).toBe('dark');
    await userEvent.click(screen.getByRole('radio', { name: 'ライト' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    await userEvent.click(screen.getByRole('button', { name: 'ホーム' }));
    expect(mainInput().value).toBe('書きかけの本文');
  });

  it('スレッド: 親＋返信（古い順）＋返信入力', async () => {
    const repo = createMockRepository([
      { id: 'p', body: '親投稿', createdAt: t(1) },
      { id: 'r2', parentId: 'p', body: '二番目の返信', createdAt: t(3) },
      { id: 'r1', parentId: 'p', body: '最初の返信', createdAt: t(2) },
    ]);
    render(<CuenuApp platform={{ repo }} />);
    await userEvent.click(await screen.findByRole('button', { name: '返信 2' }));
    const thread = await screen.findByRole('region', { name: 'スレッド' });
    await within(thread).findByText('最初の返信');
    const list = within(thread).getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('最初の返信');
    expect(items[1]).toHaveTextContent('二番目の返信');
    const replyBox = within(thread).getByRole('textbox', { name: '返信を入力' });
    await userEvent.type(replyBox, '採用。週末に試す');
    fireEvent.keyDown(replyBox, { key: 'Enter', metaKey: true });
    await within(thread).findByText('採用。週末に試す');
    await userEvent.click(within(thread).getByRole('button', { name: '戻る' }));
    expect(await screen.findByRole('button', { name: '返信 3' })).toBeInTheDocument();
    expect(screen.queryByText('採用。週末に試す')).toBeNull();
  });

  it('返信付き親の削除は返信も消えることを事前に示し、取り消せる', async () => {
    const repo = createMockRepository([
      { id: 'p', body: '親投稿', createdAt: t(1) },
      { id: 'r1', parentId: 'p', body: '返信', createdAt: t(2) },
    ]);
    render(<CuenuApp platform={{ repo }} />);
    await screen.findByText('親投稿');
    await userEvent.click(screen.getByRole('button', { name: 'その他の操作' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '削除' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('返信 1 件も一緒に削除されます');
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(screen.queryByText('親投稿')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: '取り消す' }));
    expect(await screen.findByText('親投稿')).toBeInTheDocument();
  });

  it('編集すると「編集済み」になる', async () => {
    const repo = createMockRepository([{ id: 'p', body: '元の本文', createdAt: t(1) }]);
    render(<CuenuApp platform={{ repo }} />);
    await screen.findByText('元の本文');
    await userEvent.click(screen.getByRole('button', { name: 'その他の操作' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '編集' }));
    const box = await screen.findByRole('textbox', { name: 'メモを編集' });
    await userEvent.clear(box);
    await userEvent.type(box, '直した本文');
    expect(box).toHaveValue('直した本文');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(await screen.findByText('編集済み')).toBeInTheDocument();
    expect(screen.getByText('直した本文', { selector: '.cu-md p' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'メモを編集' })).toBeNull();
  });

  it('競合を選んで解決できる', async () => {
    const server = { id: 'p', parentId: null, author: 'user' as const, body: 'サーバー版', createdAt: t(1), updatedAt: t(2), editedAt: t(2), version: 2, deletedAt: null, tags: [], tagsVersion: null, ai: null, image: null, serverSeq: 3 };
    const repo = createMockRepository([
      { id: 'p', body: '端末版', createdAt: t(1), syncState: 'conflict', conflict: { server, localBody: '端末版', localBaseVersion: 1, detectedAt: t(3) } },
    ]);
    render(<CuenuApp platform={{ repo }} />);
    expect(await screen.findByRole('img', { name: '競合あり' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'サーバーの版を残す' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: '競合あり' })).toBeNull());
    expect(screen.getByText('サーバー版')).toBeInTheDocument();
  });

  it('画像要約の失敗時に再試行・キャンセル、未反映要約の反映', async () => {
    const img = { originDeviceId: 'dev1', applied: false, baseVersion: 1 };
    const repo = createMockRepository([
      { id: 'f', body: '', createdAt: t(1), image: { ...img, status: 'failed', summary: null, error: 'rate limited' } },
      { id: 'd', body: '本文', createdAt: t(2), image: { ...img, status: 'done', summary: '猫の写真', error: null } },
    ]);
    render(<CuenuApp platform={{ repo, deviceId: 'dev1' }} />);
    expect(await screen.findByText(/画像要約に失敗しました: rate limited/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '本文に反映' }));
    expect(await screen.findByText('猫の写真', { selector: '.cu-md p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '本文に反映' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('◷ 画像要約待ち')).toBeInTheDocument();
  });

  it('検索: 返信ヒットから親スレッドへ。検索中も下書きを保持', async () => {
    const repo = createMockRepository([
      { id: 'p', body: '親のメモ', createdAt: t(1) },
      { id: 'r', parentId: 'p', body: '返信にだけあるキーワード', createdAt: t(2) },
    ]);
    render(<CuenuApp platform={{ repo }} />);
    await userEvent.type(mainInput(), '下書き中');
    await userEvent.click(screen.getByRole('button', { name: '検索' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'キーワード' }), 'キーワード');
    const hit = await screen.findByText('返信にだけあるキーワード');
    const art = hit.closest('article')!;
    expect(within(art as HTMLElement).getByText('返信')).toBeInTheDocument();
    await userEvent.click(within(art as HTMLElement).getByRole('button', { name: 'スレッドを開く' }));
    const thread = await screen.findByRole('region', { name: 'スレッド' });
    expect(await within(thread).findByText('親のメモ')).toBeInTheDocument();
    await userEvent.click(within(thread).getByRole('button', { name: '戻る' }));
    expect(screen.getByRole('searchbox', { name: 'キーワード' })).toHaveValue('キーワード');
    await userEvent.click(screen.getByRole('button', { name: 'ホーム' }));
    expect(mainInput().value).toBe('下書き中');
  });

  it('意味検索はオフライン時に理由を表示', async () => {
    const platform: CuenuPlatform = {
      repo: createMockRepository(),
      isOnline: () => false,
      auth: { isLoggedIn: () => true, login: vi.fn(), logout: vi.fn() },
      server: { semanticSearch: vi.fn(), aiStatus: vi.fn(), getSettings: vi.fn(), putSettings: vi.fn() },
    };
    render(<CuenuApp platform={platform} />);
    await userEvent.click(screen.getByRole('button', { name: '検索' }));
    await userEvent.click(screen.getByRole('tab', { name: '意味検索' }));
    expect(screen.getByText(/オフラインのため意味検索は使えません/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '探す' })).toBeDisabled();
  });

  it('意味検索（オンライン）で関連メモを表示', async () => {
    const repo = createMockRepository([{ id: 'x', body: 'アプリ案: 入力の速いメモ', createdAt: t(1) }]);
    const platform: CuenuPlatform = {
      repo,
      isOnline: () => true,
      auth: { isLoggedIn: () => true, login: vi.fn(), logout: vi.fn() },
      server: {
        semanticSearch: vi.fn(async () => ({ hits: [{ memoId: 'x', score: 0.9 }], indexedCount: 1, pendingCount: 0 })),
        aiStatus: vi.fn(),
        getSettings: vi.fn(),
        putSettings: vi.fn(),
      },
    };
    render(<CuenuApp platform={platform} />);
    await userEvent.click(screen.getByRole('button', { name: '検索' }));
    await userEvent.click(screen.getByRole('tab', { name: '意味検索' }));
    await userEvent.type(screen.getByRole('searchbox', { name: '探したい内容' }), '前に考えていたアプリ案');
    await userEvent.click(screen.getByRole('button', { name: '探す' }));
    const region = screen.getByRole('region', { name: '検索' });
    expect(await within(region).findByText('アプリ案: 入力の速いメモ')).toBeInTheDocument();
  });

  it('initialMemoId（通知タップ）で対象スレッドを開く。返信 ID なら親', async () => {
    const repo = createMockRepository([
      { id: 'p', body: '親', createdAt: t(1) },
      { id: 'r', parentId: 'p', body: '子', createdAt: t(2) },
    ]);
    render(<CuenuApp platform={{ repo }} initialMemoId="r" />);
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'スレッド' })).getByText('親')).toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'スレッド' })).getByText('子')).toBeInTheDocument();
  });

  it('ログインフォーム', async () => {
    let logged = false;
    const login = vi.fn(async () => {
      logged = true;
    });
    render(<CuenuApp platform={{ repo: createMockRepository(), auth: { isLoggedIn: () => logged, login, logout: vi.fn() } }} />);
    await userEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    await userEvent.type(screen.getByLabelText('所有者パスワード'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    expect(login).toHaveBeenCalledWith({ password: 'secret', serverUrl: undefined });
  });
});

describe('CuenuQuickInput', () => {
  it('⌘Enter で保存後 onPosted、Esc で下書きを保持して onDismiss', async () => {
    const repo = createMockRepository();
    const onPosted = vi.fn();
    const onDismiss = vi.fn();
    render(<CuenuQuickInput repo={repo} onPosted={onPosted} onDismiss={onDismiss} />);
    const box = mainInput();
    expect(box).toHaveFocus();
    await userEvent.type(box, '思いつき');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
    await userEvent.type(box, '書きかけ');
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect((await repo.getDraft('quick'))?.body).toBe('書きかけ');
  });

  it('保存失敗時は onPosted を呼ばず本文を保持', async () => {
    const repo = createMockRepository();
    repo.failNextCreate();
    const onPosted = vi.fn();
    render(<CuenuQuickInput repo={repo} onPosted={onPosted} />);
    await userEvent.type(mainInput(), '大事');
    fireEvent.keyDown(mainInput(), { key: 'Enter', metaKey: true });
    await screen.findByRole('alert');
    expect(onPosted).not.toHaveBeenCalled();
    expect(mainInput().value).toBe('大事');
  });

  it('focusSignal が変わるとフォーカス', async () => {
    const repo = createMockRepository();
    const r = render(<CuenuQuickInput repo={repo} focusSignal={1} />);
    mainInput().blur();
    r.rerender(<CuenuQuickInput repo={repo} focusSignal={2} />);
    expect(mainInput()).toHaveFocus();
    await act(async () => {});
  });
});
