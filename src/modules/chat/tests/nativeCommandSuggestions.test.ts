import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useProjectSlashCommands } from '@/shared/hooks/useProjectSlashCommands';
import type { LLMProvider, PermissionMode, Project } from '@/shared/types';

const project: Project = { projectId: 'compact-project', displayName: 'Compact test', fullPath: '/tmp/compact-project' };
const compact = {
  name: '/compact', description: 'Summarize conversation history, preserving important context',
  namespace: 'builtin', type: 'provider', metadata: { type: 'builtin', provider: 'claude' },
};
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
let requests: string[];

beforeEach(() => {
  localStorage.clear();
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const target = String(url);
    requests.push(target);
    if (target === '/api/commands/list') return json({ builtIn: [{ name: '/help' }, compact], custom: [] });
    if (target.includes('/skills')) return json({ data: { skills: [] } });
    if (target === '/api/commands/execute') return json({ type: 'builtin', action: 'help', data: {} });
    return json([]);
  }));
});

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

test('native Claude commands keep their provider execution mode and stay out of other providers', async () => {
  const view = renderHook(({ provider }: { provider: LLMProvider }) => useProjectSlashCommands(project, provider), {
    initialProps: { provider: 'claude' as LLMProvider },
  });
  await waitFor(() => assert.equal(view.result.current.commands.length, 2));
  assert.equal(view.result.current.commands.find(command => command.name === '/compact')?.type, 'provider');
  view.rerender({ provider: 'codex' });
  await waitFor(() => assert.deepEqual(view.result.current.commands.map(command => command.name), ['/help']));
});

const renderComposer = async () => {
  const sent: Array<{ type: string; content?: string }> = [];
  const view = renderHook(() => useChatComposerState({
    selectedProject: project, selectedSession: { id: 'compact-session' }, currentSessionId: 'compact-session',
    provider: 'claude', permissionMode: 'default', cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model', currentProviderEffort: 'medium', isLoading: false, canAbortSession: false,
    tokenBudget: null, sendMessage: message => { sent.push(message as typeof sent[number]); },
    scrollToBottom: () => undefined, addMessage: () => undefined, setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 2));
  return { view, sends: () => sent.filter(message => message.type === 'chat.send') };
};

for (const key of ['Enter', 'Tab', 'click']) {
  test(`selecting native /compact with ${key} completes the input without executing a CloudCLI action`, async () => {
    const { view, sends } = await renderComposer();
    const textarea = document.createElement('textarea');
    Object.assign(view.result.current.textareaRef, { current: textarea });
    textarea.value = '/comp';
    textarea.setSelectionRange(5, 5);
    act(() => { view.result.current.handleInputChange({ target: textarea } as never); });
    await waitFor(() => assert.deepEqual(view.result.current.filteredCommands.map(command => command.name), ['/compact']));
    act(() => {
      if (key === 'click') view.result.current.handleCommandSelect(view.result.current.filteredCommands[0], 0, false);
      else view.result.current.handleKeyDown({ key, nativeEvent: {}, preventDefault: () => undefined } as never);
    });
    await waitFor(() => assert.equal(view.result.current.input, '/compact '));
    assert.equal(view.result.current.showCommandMenu, false);
    assert.equal(requests.includes('/api/commands/execute'), false);
    assert.deepEqual(sends(), []);
  });
}

test('submitting /compact preserves native arguments and the existing session', async () => {
  const { view, sends } = await renderComposer();
  const command = '/compact 保留接口决策\n和未完成的任务';
  act(() => { view.result.current.setInput(command); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  await waitFor(() => assert.equal(sends().length, 1));
  assert.equal(sends()[0].content, command);
  assert.equal((sends()[0] as Record<string, unknown>).sessionId, 'compact-session');
  assert.equal(requests.includes('/api/commands/execute'), false);
});
