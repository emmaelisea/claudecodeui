import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { AnyRecord } from '@/shared/types.js';

type UsageWindow = { usedPercentage: number; resetsAt: string };

const outputSpeeds = new Map<string, { tokensPerSecond: number; measuredAt: number }>();
let limits: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null } | null = null;
let checkedAt = 0;
let pending: Promise<void> | null = null;

function readWindow(value: unknown): UsageWindow | null {
  const row = value as { utilization?: unknown; resets_at?: unknown } | null;
  if (typeof row?.utilization !== 'number' || !Number.isFinite(row.utilization)
    || row.utilization < 0 || row.utilization > 100 || typeof row.resets_at !== 'string'
    || !(Date.parse(row.resets_at) > Date.now())) return null;
  return { usedPercentage: row.utilization, resetsAt: row.resets_at };
}

async function refreshLimits(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let release: (() => void) | undefined;
  const input = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
    release = () => resolve({ done: true, value: undefined });
  });
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => input }),
  };
  let instance: ReturnType<typeof query> | undefined;
  try {
    // A control-only CLI process: no prompt, model request, transcript or tools.
    instance = query({
      prompt,
      options: {
        cwd: os.tmpdir(),
        tools: [],
        settingSources: ['user'],
        pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
        env: { ...process.env },
        abortController: controller,
        persistSession: false,
      },
    });
    const usage = await instance.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    limits = usage.rate_limits_available ? {
      fiveHour: readWindow(usage.rate_limits?.five_hour),
      sevenDay: readWindow(usage.rate_limits?.seven_day),
    } : null;
  } catch {
    limits = null;
  } finally {
    checkedAt = Date.now();
    clearTimeout(timer);
    release?.();
    instance?.close();
  }
}

/** Used by the Claude runtime to retain a measured main-agent output rate. */
export function rememberClaudeOutputSpeed(sessionId: string, tokens: number, milliseconds: number): void {
  if (!sessionId || !Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(milliseconds) || milliseconds < 50) return;
  outputSpeeds.delete(sessionId);
  outputSpeeds.set(sessionId, { tokensPerSecond: tokens * 1000 / milliseconds, measuredAt: Date.now() });
  if (outputSpeeds.size > 1000) outputSpeeds.delete(outputSpeeds.keys().next().value!);
}

/** Used by each Claude run to measure output from SDK token counts and stream timings, excluding tool execution. */
export function createClaudeOutputMeter(
  sessionId: string,
  now = () => performance.now(),
  record = rememberClaudeOutputSpeed,
) {
  let startedAt: number | null = null;
  let outputTokens = 0;
  return (message: AnyRecord) => {
    if (message.type !== 'stream_event' || message.parent_tool_use_id) return;
    const event = message.event;
    if (event?.type === 'message_start') {
      startedAt = null;
      outputTokens = 0;
    } else if (event?.type === 'content_block_delta') {
      startedAt ??= now();
    } else if (event?.type === 'message_delta' && typeof event.usage?.output_tokens === 'number') {
      outputTokens = event.usage.output_tokens;
    } else if (event?.type === 'message_stop' && startedAt !== null) {
      record(sessionId, outputTokens, now() - startedAt);
      startedAt = null;
    }
  };
}

/** Used by provider routes for authenticated, coalesced plan usage and session speed reads. */
export async function readClaudePerformance(sessionId?: string) {
  if (Date.now() - checkedAt > 60_000) {
    pending ??= refreshLimits().finally(() => { pending = null; });
    await pending;
  }
  return {
    fiveHour: limits?.fiveHour && Date.parse(limits.fiveHour.resetsAt) > Date.now() ? limits.fiveHour : null,
    sevenDay: limits?.sevenDay && Date.parse(limits.sevenDay.resetsAt) > Date.now() ? limits.sevenDay : null,
    speed: sessionId ? outputSpeeds.get(sessionId) ?? null : null,
    checkedAt,
  };
}
