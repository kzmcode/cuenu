import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CuenuApp } from '../src/App';
import { dayKey } from '../src/format';
import { createMockRepository } from '../src/mockRepository';

const iso = (s: string) => new Date(s).toISOString();
const aiMeta = { kind: 'action' as const, sourceIds: ['u1'], sourceVersions: [1], model: 'm', jobId: 'j' };

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
});

describe('カレンダー', () => {
  it('今日の記録を表示し、記録のある日を選ぶとその日のメモに切り替わる', async () => {
    const now = new Date();
    const today = dayKey(now.toISOString(), 'Asia/Tokyo');
    const other = today.endsWith('-01') ? `${today.slice(0, 8)}02` : `${today.slice(0, 8)}01`;
    const repo = createMockRepository([
      { id: 'u1', body: '今日のメモ', createdAt: now.toISOString() },
      { id: 'u2', body: '別の日のメモ', createdAt: iso(`${other}T03:00:00Z`) },
    ]);
    render(<CuenuApp platform={{ repo, kind: 'web' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'カレンダー' }));
    const cal = await screen.findByRole('region', { name: 'カレンダー' });
    expect(await within(cal).findByText('今日のメモ')).toBeInTheDocument();
    expect(within(cal).queryByText('別の日のメモ')).toBeNull();
    const day = within(cal).getByRole('button', { name: new RegExp(`^${Number(other.slice(5, 7))}月${Number(other.slice(8))}日.* 1 件$`) });
    await userEvent.click(day);
    expect(day).toHaveAttribute('aria-pressed', 'true');
    expect(await within(cal).findByText('別の日のメモ')).toBeInTheDocument();
    expect(within(cal).queryByText('今日のメモ')).toBeNull();
  });
});

describe('通知（AI の投稿）', () => {
  it('未読数を表示し、開くと AI の投稿だけが並んで既読になる', async () => {
    const repo = createMockRepository([
      { id: 'u1', body: '自分のメモ', createdAt: iso('2026-11-04T01:00:00Z') },
      { id: 'a1', author: 'ai', body: 'AIの提案その1', createdAt: iso('2026-11-04T02:00:00Z'), ai: aiMeta },
      { id: 'a2', author: 'ai', body: 'AIの提案その2', createdAt: iso('2026-11-04T03:00:00Z'), ai: aiMeta },
    ]);
    render(<CuenuApp platform={{ repo, kind: 'web' }} />);
    const bell = await screen.findByRole('button', { name: 'AIの投稿（未読 2 件）' });
    await userEvent.click(bell);
    const list = await screen.findByRole('region', { name: 'AIの投稿' });
    expect(await within(list).findByText('AIの提案その2')).toBeInTheDocument();
    expect(within(list).getByText('AIの提案その1')).toBeInTheDocument();
    expect(within(list).queryByText('自分のメモ')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'AIの投稿' })).toBeInTheDocument());
  });
});

describe('いいねのアニメーション', () => {
  it('付けた時だけ弾む演出のクラスが付く', async () => {
    const repo = createMockRepository([{ id: 'a1', author: 'ai', body: 'AIの提案', createdAt: iso('2026-11-04T02:00:00Z'), ai: aiMeta }]);
    render(<CuenuApp platform={{ repo, kind: 'web' }} />);
    const like = await screen.findByRole('button', { name: 'いいね' });
    await userEvent.click(like);
    await waitFor(() => expect(screen.getByRole('button', { name: 'いいね' })).toHaveClass('cu-like--pop'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'いいね' })).not.toHaveClass('cu-like--pop'), { timeout: 1500 });
    await userEvent.click(screen.getByRole('button', { name: 'いいね' }));
    expect(screen.getByRole('button', { name: 'いいね' })).not.toHaveClass('cu-like--pop');
  });
});

describe('検索フォーム', () => {
  it('絞り込みは折りたたみで、投稿者を選ぶと件数が付く', async () => {
    const repo = createMockRepository([
      { id: 'u1', body: '試作メモ', createdAt: iso('2026-11-04T01:00:00Z') },
      { id: 'a1', author: 'ai', body: '試作の提案', createdAt: iso('2026-11-04T02:00:00Z'), ai: aiMeta },
    ]);
    render(<CuenuApp platform={{ repo, kind: 'web' }} />);
    await userEvent.click(screen.getByRole('button', { name: '検索' }));
    const toggle = screen.getByRole('button', { name: /絞り込み/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('開始日')).toBeNull();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: 'AI' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'キーワード' }), '試作');
    const region = screen.getByRole('region', { name: '検索' });
    expect(await within(region).findByText('試作の提案')).toBeInTheDocument();
    expect(within(region).queryByText('試作メモ')).toBeNull();
    expect(screen.getByRole('button', { name: /絞り込み/ })).toHaveTextContent('1');
  });
});
