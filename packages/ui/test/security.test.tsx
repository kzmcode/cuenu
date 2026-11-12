import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownImpl from '../src/components/MarkdownImpl';
import { getThemeInitScript } from '../src/theme/script';

describe('Markdown の安全な描画', () => {
  it('生 HTML は描画しない', () => {
    const { container } = render(<MarkdownImpl source={'<img src=x onerror="alert(1)"><script>alert(1)</script>本文'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  it('javascript: / data: のリンクは無効化し、外部リンクは noopener で開く', () => {
    const { container } = render(
      <MarkdownImpl source={'[a](javascript:alert(1)) [b](data:text/html,<script>alert(1)</script>) [c](https://example.com)'} />,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => /^\s*(javascript|data):/i.test(h))).toBe(false);
    const ok = screen.getByRole('link', { name: 'c' });
    expect(ok).toHaveAttribute('href', 'https://example.com');
    expect(ok).toHaveAttribute('target', '_blank');
    expect(ok.getAttribute('rel')).toContain('noopener');
  });

  it('画像は読み込まず代替テキストだけ表示する', () => {
    const { container } = render(<MarkdownImpl source={'![追跡](https://tracker.example/p.png)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('[画像: 追跡]');
  });
});

describe('リンクの遷移先表示', () => {
  it('危険な URL で href が除去されたリンクはアンカーにしない', () => {
    const { container } = render(<MarkdownImpl source={'[押して](javascript:alert(1))'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('押して');
  });

  it('自分のメモはリンクテキストをそのまま表示する', () => {
    render(<MarkdownImpl source={'[公式サイト](https://evil.example/login)'} />);
    expect(screen.getByRole('link', { name: '公式サイト' })).toHaveAttribute('href', 'https://evil.example/login');
  });

  it('AI 投稿ではテキストと異なる遷移先のホスト名を併記する', () => {
    render(<MarkdownImpl untrusted source={'[公式サイト](https://evil.example/login) [https://bank.example](https://evil.example)'} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent('公式サイト (evil.example)');
    expect(links[0]).toHaveAttribute('title', 'https://evil.example/login');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]!.getAttribute('rel')).toContain('noopener');
    expect(links[1]).toHaveTextContent('https://bank.example (evil.example)');
  });

  it('AI 投稿でも国際化ドメインは punycode で表示する', () => {
    render(<MarkdownImpl untrusted source={'[apple](https://аpple.com)'} />);
    expect(screen.getByRole('link')).toHaveTextContent('(xn--pple-43d.com)');
  });

  it('AI 投稿の自動リンクは URL を重複表示しない', () => {
    render(<MarkdownImpl untrusted source={'見て https://example.com/a と www.example.org'} />);
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', 'https://example.com/a');
    expect(links[0]!.querySelector('.cu-md-link-dest')).toBeNull();
    expect(links[1]).toHaveAttribute('href', 'http://www.example.org');
    expect(links[1]!.querySelector('.cu-md-link-dest')).toBeNull();
  });

  it('AI 投稿でも危険な URL はアンカーにしない', () => {
    const { container } = render(<MarkdownImpl untrusted source={'[押して](javascript:alert(1))'} />);
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('テーマ初期化スクリプト', () => {
  it('保存キーに </script> を含めても script 要素から抜け出さない', () => {
    const s = getThemeInitScript('k</script><script>alert(1)//');
    expect(s).not.toContain('</script');
    expect(() => new Function(s)).not.toThrow();
  });
});
