import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import type { ProjectSession } from '@/shared/types';

const mocks = vi.hoisted(() => ({ read: vi.fn(), change: vi.fn() }));
const json = (mode: string) => ({ ok: true, json: async () => ({ success: true, data: { permissionMode: mode } }) });
vi.mock('@/shared/api', () => ({ api: {
  providers: {
    models: async () => ({ ok: true, json: async () => ({ success: true, data: null }) }),
    capabilities: async () => ({ ok: true, json: async () => ({ success: true, data: null }) }),
    sessionActiveModel: mocks.read,
    setClaudeSessionPermissionMode: mocks.change,
  },
} }));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.read.mockReset().mockResolvedValue(json('auto'));
  mocks.change.mockReset();
});
const renderState = () => renderHook(({ id }) => useChatProviderState({
  selectedSession: { id, __provider: 'claude' } as ProjectSession, selectedProject: null,
}), { initialProps: { id: 'one' } });

test('the server mode replaces stale browser state and a pick waits for acknowledgment', async () => {
  localStorage.setItem('permissionMode-one', 'bypassPermissions');
  const { result } = renderState();
  await waitFor(() => assert.equal(result.current.permissionMode, 'auto'));
  let acknowledge!: (value: unknown) => void;
  mocks.change.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
  let change!: Promise<void>;
  act(() => { change = result.current.selectPermissionMode('bypassPermissions', true); });
  assert.equal(result.current.permissionMode, 'auto');
  assert.equal(result.current.permissionModeChanging, true);
  assert.equal(localStorage.getItem('permissionMode-one'), 'auto');
  mocks.read.mockResolvedValue(json('bypassPermissions'));
  await act(async () => { acknowledge(json('bypassPermissions')); await change; });
  assert.equal(result.current.permissionMode, 'bypassPermissions');
  assert.equal(result.current.permissionModeChanging, false);
  assert.equal(localStorage.getItem('permissionMode-one'), 'bypassPermissions');
  assert.deepEqual(mocks.change.mock.calls[0], ['one', 'bypassPermissions', true]);
});

test('a refused live change keeps the old mode and reports the failure', async () => {
  const { result } = renderState();
  await waitFor(() => assert.equal(result.current.permissionMode, 'auto'));
  let refuse!: (value: unknown) => void;
  mocks.change.mockReturnValue(new Promise((resolve) => { refuse = resolve; }));
  let change!: Promise<void>;
  act(() => { change = result.current.selectPermissionMode('bypassPermissions', true); });
  assert.equal(result.current.permissionModeChanging, true);
  await act(async () => {
    refuse({ ok: false, json: async () => ({ success: false, error: { message: 'CLI refused' } }) });
    await change;
  });
  assert.equal(result.current.permissionMode, 'auto');
  assert.equal(localStorage.getItem('permissionMode-one'), 'auto');
  // The completion GET may run after the failure; it must not hide that failure.
  assert.match(result.current.permissionModeError || '', /CLI refused/);
});

test('a late load cannot replace a mode acknowledged by a newer pick', async () => {
  let finishLoad!: (value: unknown) => void;
  mocks.read.mockReturnValueOnce(new Promise((resolve) => { finishLoad = resolve; }));
  mocks.read.mockResolvedValue(json('bypassPermissions'));
  mocks.change.mockResolvedValue(json('bypassPermissions'));
  const { result } = renderState();
  await waitFor(() => assert.equal(mocks.read.mock.calls.length, 1));
  await act(async () => { await result.current.selectPermissionMode('bypassPermissions', true); });
  await act(async () => { finishLoad(json('auto')); });
  assert.equal(result.current.permissionMode, 'bypassPermissions');
});

test('changing chats while a pick is pending cannot change the new chat mode', async () => {
  let acknowledge!: (value: unknown) => void;
  mocks.change.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
  const { result, rerender } = renderState();
  await waitFor(() => assert.equal(result.current.permissionMode, 'auto'));
  let change!: Promise<void>;
  act(() => { change = result.current.selectPermissionMode('bypassPermissions', true); });
  mocks.read.mockResolvedValue(json('default'));
  rerender({ id: 'two' });
  await act(async () => { acknowledge(json('bypassPermissions')); await change; });
  await waitFor(() => assert.equal(result.current.permissionMode, 'default'));
  assert.equal(localStorage.getItem('permissionMode-one'), 'bypassPermissions');
  assert.equal(localStorage.getItem('permissionMode-two'), 'default');
});


test('a just-created live session is updated even before the parent sidebar selects it', async () => {
  mocks.change.mockResolvedValue(json('bypassPermissions'));
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await act(async () => { await result.current.selectPermissionMode('bypassPermissions', true, 'new-live-session'); });
  assert.deepEqual(mocks.change.mock.calls[0], ['new-live-session', 'bypassPermissions', true]);
  assert.equal(result.current.permissionMode, 'bypassPermissions');
  assert.equal(localStorage.getItem('permissionMode-new-live-session'), 'bypassPermissions');
});
