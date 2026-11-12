import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PlatformProvider, type CuenuPlatform } from '../src/platform';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { createMockRepository } from '../src/mockRepository';

export function renderWithPlatform(ui: ReactElement, platform: Partial<CuenuPlatform> = {}) {
  const repo = (platform.repo as ReturnType<typeof createMockRepository>) ?? createMockRepository();
  const p: CuenuPlatform = { ...platform, repo };
  return { repo, ...render(<ThemeProvider><PlatformProvider platform={p}>{ui}</PlatformProvider></ThemeProvider>) };
}
