// 担当B の createMemoryRepository（実装）と組み合わせた結合テスト
import { createMemoryRepository } from '@cuenu/core/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CuenuApp } from '../src/App';

describe('CuenuApp + @cuenu/core/client memory repository', () => {
  it('投稿・返信・検索の基本動作', async () => {
    const repo = createMemoryRepository({ deviceId: 'dev-test' });
    render(<CuenuApp platform={{ repo, deviceId: 'dev-test' }} />);
    const box = screen.getByRole('textbox', { name: 'メモを入力' });
    await userEvent.type(box, 'メモアプリを作りたい');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    const feed = screen.getByRole('feed');
    expect(await within(feed).findByText('メモアプリを作りたい')).toBeInTheDocument();
    expect(within(feed).getByRole('img', { name: '同期待ち' })).toBeInTheDocument();

    await userEvent.click(within(feed).getByRole('button', { name: '返信' }));
    const thread = await screen.findByRole('region', { name: 'スレッド' });
    const reply = within(thread).getByRole('textbox', { name: '返信を入力' });
    await userEvent.type(reply, '採用。週末に試す');
    fireEvent.keyDown(reply, { key: 'Enter', ctrlKey: true });
    expect(await within(thread).findByText('採用。週末に試す')).toBeInTheDocument();
    await userEvent.click(within(thread).getByRole('button', { name: '戻る' }));
    expect(await within(feed).findByRole('button', { name: '返信 1' })).toBeInTheDocument();
    expect(within(feed).queryByText('採用。週末に試す')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '検索' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'キーワード' }), '週末');
    const region = screen.getByRole('region', { name: '検索' });
    await waitFor(() => expect(within(region).getByText('採用。週末に試す')).toBeInTheDocument());
    expect(within(region).getByRole('button', { name: 'スレッドを開く' })).toBeInTheDocument();
  });
});
