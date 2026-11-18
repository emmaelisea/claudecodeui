import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeOutputMeter } from '@/modules/providers/services/claude-performance.service.js';

test('TPS uses SDK output tokens and generation time, excluding tool pauses and subagents', () => {
  let now = 0;
  const readings: unknown[] = [];
  const meter = createClaudeOutputMeter('session', () => now, (...reading) => { readings.push(reading); });
  const emit = (event: object) => meter({ type: 'stream_event', event });
  emit({ type: 'message_start' });
  now = 10_000; // time to first output is excluded
  emit({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } });
  now = 11_000;
  emit({ type: 'message_delta', usage: { output_tokens: 120 } });
  emit({ type: 'message_stop' });
  now = 90_000; // long tool call is excluded
  meter({ type: 'stream_event', parent_tool_use_id: 'agent', event: { type: 'message_start' } });
  emit({ type: 'message_start' });
  emit({ type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } });
  now = 92_000;
  emit({ type: 'message_delta', usage: { output_tokens: 80 } });
  emit({ type: 'message_stop' });
  assert.deepEqual(readings, [['session', 120, 1000], ['session', 80, 2000]]);
});

test('a response without measured streamed output produces no speed reading', () => {
  const readings: unknown[] = [];
  const meter = createClaudeOutputMeter('session', () => 0, (...reading) => { readings.push(reading); });
  meter({ type: 'result', usage: { output_tokens: 100 } });
  meter({ type: 'stream_event', event: { type: 'message_stop' } });
  assert.deepEqual(readings, []);
});
