import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Timeline } from '../src/components/Timeline';
import { createMockRepository } from '../src/mockRepository';
import { renderWithPlatform } from './helpers';

const t = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString();

describe('Timeline', () => {
  it('新しい順に表示し、返信はトップレベルに出さない', async () => {
    const repo = createMockRepository([
      { id: 'a', body: '古い投稿', createdAt: t(1) },
      { id: 'b', body: '新しい投稿', createdAt: t(2) },
      { id: 'r', parentId: 'a', body: '返信本文', createdAt: t(3) },
    ]);
    renderWithPlatform(<Timeline />, { repo });
    const feed = await screen.findByRole('feed');
    await waitFor(() => expect(within(feed).getAllByRole('article')).toHaveLength(2));
    const arts = within(feed).getAllByRole('article');
    expect(arts[0]).toHaveTextContent('新しい投稿');
    expect(arts[1]).toHaveTextContent('古い投稿');
    expect(within(arts[1]!).getByRole('button', { name: '返信 1' })).toBeInTheDocument();
    expect(screen.queryByText('返信本文')).toBeNull();
  });

  it('新しい返信が来てもトップレベルに出ず、返信数だけ増える', async () => {
    const repo = createMockRepository([{ id: 'a', body: '親', createdAt: t(1) }]);
    renderWithPlatform(<Timeline />, { repo });
    await screen.findByText('親');
    await act(async () => {
      await repo.create({ body: '新しい返信', parentId: 'a' });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '返信 1' })).toBeInTheDocument());
    expect(screen.queryByText('新しい返信')).toBeNull();
  });

  it('長文は省略し、その場で展開・折りたたみできる', async () => {
    const long = Array.from({ length: 20 }, (_, i) => `${i + 1}行目`).join('\n\n');
    const repo = createMockRepository([{ id: 'a', body: long }]);
    renderWithPlatform(<Timeline />, { repo });
    const btn = await screen.findByRole('button', { name: '続きを表示' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    const body = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(body).toHaveClass('cu-memo-body--collapsed');
    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: '折りたたむ' })).toHaveAttribute('aria-expanded', 'true');
    expect(body).not.toHaveClass('cu-memo-body--collapsed');
    await userEvent.click(screen.getByRole('button', { name: '折りたたむ' }));
    expect(body).toHaveClass('cu-memo-body--collapsed');
  });

  it('AI 投稿はラベルを表示し、参照元は本文中に出さず「…」メニューから開く', async () => {
    const repo = createMockRepository([
      { id: 'src', body: '元メモ', createdAt: t(1) },
      { id: 'ai1', author: 'ai', body: '試作してみませんか？', createdAt: t(2), ai: { kind: 'action', sourceIds: ['src'], sourceVersions: [1], model: 'm', jobId: 'j' } },
    ]);
    renderWithPlatform(<Timeline />, { repo });
    expect(await screen.findByText('AI · 行動の提案')).toBeInTheDocument();
    expect(screen.queryByText(/参照元/)).toBeNull();
    const ai = screen.getByText('試作してみませんか？').closest('article')!;
    await userEvent.click(within(ai).getByRole('button', { name: 'その他の操作' }));
    expect(within(ai).getByRole('menuitem', { name: '参照元のメモを開く' })).toBeInTheDocument();
    expect(within(ai).getByRole('menuitem', { name: '非表示' })).toBeInTheDocument();
    expect(within(ai).queryByRole('menuitem', { name: '編集' })).toBeNull();
  });

  it('自分のメモは AI の絵文字を丸なしで、AI 投稿は丸付きの ✦ で表示', async () => {
    const repo = createMockRepository([
      { id: 'u1', body: '記事を読む', emoji: '☕', createdAt: t(1) },
      { id: 'u2', body: 'まだ絵文字なし', createdAt: t(2) },
      { id: 'ai1', author: 'ai', body: '提案', createdAt: t(3), ai: { kind: 'action', sourceIds: ['u1'], sourceVersions: [1], model: 'm', jobId: 'j' } },
    ]);
    const { container } = renderWithPlatform(<Timeline />, { repo });
    await screen.findByText('記事を読む');
    const av = (id: string) => container.querySelector(`[data-memo-id="${id}"] .cu-avatar`)!;
    expect(av('u1')).toHaveTextContent('☕');
    expect(av('u1')).toHaveClass('cu-avatar--plain');
    expect(av('u2').querySelector('svg')).not.toBeNull();
    expect(av('ai1')).toHaveClass('cu-avatar--ai');
    expect(av('ai1')).not.toHaveClass('cu-avatar--plain');
  });

  it('AI 投稿にだけいいねボタンがあり、押すと付け外しできる', async () => {
    const repo = createMockRepository([
      { id: 'u1', body: '自分のメモ', createdAt: t(1) },
      { id: 'ai1', author: 'ai', body: 'AIの提案', createdAt: t(2), ai: { kind: 'action', sourceIds: ['u1'], sourceVersions: [1], model: 'm', jobId: 'j' } },
    ]);
    renderWithPlatform(<Timeline />, { repo });
    await screen.findByText('AIの提案');
    const like = screen.getByRole('button', { name: 'いいね' });
    expect(screen.getAllByRole('button', { name: 'いいね' })).toHaveLength(1);
    expect(like).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(like);
    await waitFor(() => expect(screen.getByRole('button', { name: 'いいね' })).toHaveAttribute('aria-pressed', 'true'));
    expect((await repo.get('ai1'))?.liked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'いいね' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'いいね' })).toHaveAttribute('aria-pressed', 'false'));
  });

  it('同期状態・編集済みを文字で表示', async () => {
    const repo = createMockRepository([
      { id: 'a', body: '未送信', syncState: 'pending', createdAt: t(1) },
      { id: 'b', body: '失敗', syncState: 'error', syncError: 'network', createdAt: t(2) },
      { id: 'c', body: '編集した', editedAt: t(5), createdAt: t(3) },
    ]);
    renderWithPlatform(<Timeline />, { repo });
    expect(await screen.findByRole('img', { name: '同期待ち' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '同期失敗' })).toBeInTheDocument();
    expect(screen.getByText('編集済み')).toBeInTheDocument();
  });

  it('スクロール中の新着は差し込まず「新しい投稿」を表示', async () => {
    const repo = createMockRepository([{ id: 'a', body: '既存', createdAt: t(1) }]);
    let scrollTop = 500;
    renderWithPlatform(<Timeline getScrollTop={() => scrollTop} />, { repo });
    await screen.findByText('既存');
    act(() => repo.injectRemote({ id: 'n', author: 'ai', body: '新着AI', createdAt: t(10) }));
    const btn = await screen.findByRole('button', { name: /新しい投稿 1 件/ });
    expect(screen.queryByText('新着AI')).toBeNull();
    scrollTop = 0;
    await userEvent.click(btn);
    expect(screen.getByText('新着AI')).toBeInTheDocument();
  });

  it('段階読み込み', async () => {
    const repo = createMockRepository(Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, body: `memo ${i}`, createdAt: t(i) })));
    renderWithPlatform(<Timeline />, { repo });
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(30));
    await userEvent.click(screen.getByRole('button', { name: 'さらに読み込む' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(45));
  });

  it('Markdown を安全に表示（生 HTML・javascript: を無効化）', async () => {
    const repo = createMockRepository([
      { id: 'a', body: '# 見出し\n\n- [x] 済\n\n`code`\n\n> 引用\n\n<script>alert(1)</script><b>太字</b>\n\n[危険](javascript:alert(1)) [安全](https://example.com)' },
    ]);
    const { container } = renderWithPlatform(<Timeline />, { repo });
    await screen.findByText('見出し');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('input[type=checkbox]')).toBeChecked();
    expect(container.querySelector('code')).toHaveTextContent('code');
    expect(container.querySelector('blockquote')).toHaveTextContent('引用');
    expect(screen.getByText('危険').getAttribute('href') ?? '').not.toMatch(/javascript/);
    expect(screen.getByText('安全')).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByText('安全')).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
