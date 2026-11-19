import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeOutputMeter } from '@/modules/providers/services/claude-performance.service.js';

const result = (output_tokens: number, duration_ms: number) => ({
  type: 'result', subtype: 'success', is_error: false, usage: { output_tokens }, duration_ms,
});

test('buffered delivery cannot turn 900 tokens delivered in 100ms into 9000 TPS', () => {
  const readings: unknown[] = [];
  const meter = createClaudeOutputMeter('session', (...reading) => { readings.push(reading); });
  meter({ type: 'stream_event', event: { type: 'message_start' } });
  meter({ type: 'stream_event', event: { type: 'content_block_delta' } });
  meter({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 900 } } });
  meter({ type: 'stream_event', event: { type: 'message_stop' } });
  assert.deepEqual(readings, [], 'arrival times cannot measure model throughput');
  meter({ ...result(900, 20_000), duration_api_ms: 10_000 });
  assert.deepEqual(readings, [['session', 900, 20_000]], 'whole-turn average is 45 tok/s, including tool time');
});

test('streaming follow-ups and resumed sessions use per-turn counts, not cumulative model totals', () => {
  const readings: unknown[] = [];
  const meter = createClaudeOutputMeter('session', (...reading) => { readings.push(reading); });
  meter({ ...result(100, 2000), modelUsage: { opus: { outputTokens: 50_000 } } });
  meter({ ...result(60, 3000), modelUsage: { opus: { outputTokens: 50_060 } } });
  assert.deepEqual(readings, [['session', 100, 2000], ['session', 60, 3000]]);
});

test('missing, invalid, subagent, command and failed-turn metrics produce no reading', () => {
  const readings: unknown[] = [];
  const meter = createClaudeOutputMeter('session', (...reading) => { readings.push(reading); });
  for (const message of [
    { type: 'result' }, result(100, 0), result(100, NaN), result(Infinity, 1000), result(-1, 1000),
    { ...result(100, 1000), parent_tool_use_id: 'agent' },
    { ...result(100, 1000), local_command: 'compact' },
    { ...result(100, 1000), is_error: true },
    { ...result(100, 1000), subtype: 'error_max_turns' },
  ]) meter(message);
  assert.deepEqual(readings, []);
});
