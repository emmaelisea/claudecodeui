import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import ClaudeUsageSummary from '@/modules/chat/composer/ClaudeUsageSummary';

const readPerformance = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ api: { providers: { claudePerformance: readPerformance } } }));

afterEach(() => { readPerformance.mockReset(); });
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const future = '2099-01-01T00:00:00Z';

test('real zero usage is shown and measured speed is formatted beside it', async () => {
  readPerformance.mockResolvedValue(response({
    fiveHour: { usedPercentage: 0, resetsAt: future },
    sevenDay: { usedPercentage: 27, resetsAt: future },
    speed: { tokensPerSecond: 42.25, measuredAt: 1795000000000 },
  }));
  render(<ClaudeUsageSummary sessionId="one" />);
  expect(await screen.findByText('42.3 tok/s')).toBeTruthy();
  expect(screen.getByText(/0%/)).toBeTruthy();
  expect(screen.getByText(/27%/)).toBeTruthy();
});

test('unavailable, expired and invalid metrics stay hidden', async () => {
  readPerformance.mockResolvedValue(response({
    fiveHour: { usedPercentage: 50, resetsAt: '2000-01-01T00:00:00Z' },
    sevenDay: { usedPercentage: 120, resetsAt: future },
    speed: null,
  }));
  const { container } = render(<ClaudeUsageSummary />);
  await waitFor(() => expect(readPerformance).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  expect(container.textContent).toBe('');
});

test('switching sessions cannot display a late speed reading from the old session', async () => {
  let resolve!: (value: unknown) => void;
  readPerformance.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  readPerformance.mockResolvedValue(response({ fiveHour: null, sevenDay: null, speed: null }));
  const { rerender, container } = render(<ClaudeUsageSummary sessionId="old" />);
  rerender(<ClaudeUsageSummary sessionId="new" />);
  await act(async () => {
    resolve(response({ speed: { tokensPerSecond: 999, measuredAt: 1 } }));
  });
  expect(container.textContent).toBe('');
});
