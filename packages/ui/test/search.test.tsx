import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Search } from '../src/components/Search';
import { createMockRepository } from '../src/mockRepository';
import { renderWithPlatform } from './helpers';

describe('Search', () => {
  it('検索中に条件を消すと、古い結果を出さず「検索中…」も残らない', async () => {
    const repo = createMockRepository([{ id: 'm1', body: 'りんごのメモ' }]);
    const original = repo.search.bind(repo);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    repo.search = async (q) => {
      const res = await original(q);
      await gate;
      return res;
    };
    renderWithPlatform(<Search />, { repo });
    const box = screen.getByRole('searchbox', { name: 'キーワード' });
    await userEvent.type(box, 'りんご');
    await waitFor(() => expect(screen.getByText('検索中…')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '入力を消す' }));
    await waitFor(() => expect(screen.queryByText('検索中…')).toBeNull());
    await act(async () => {
      release();
      await gate;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText('りんごのメモ')).toBeNull();
    expect(screen.queryByText('検索中…')).toBeNull();
  });
});
