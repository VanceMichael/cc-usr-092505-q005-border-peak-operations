import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinutes, toIso, shift, diffMinutes, buildSlots, resolveShift, inSlot,
} from '../src/time.js';

test('墙钟分钟与 ISO 互转', () => {
  assert.equal(toIso(toMinutes('2026-10-01T20:00')), '2026-10-01T20:00');
  assert.equal(diffMinutes('2026-10-02T00:30', '2026-10-01T20:00'), 270);
  assert.equal(shift('2026-10-01T23:45', 30), '2026-10-02T00:15');
});

test('跨午夜班次解析：结束早于开始即跨入次日', () => {
  const s = resolveShift('2026-10-01', '20:00', '02:00');
  assert.equal(s.start, '2026-10-01T20:00');
  assert.equal(s.end, '2026-10-02T02:00');
  assert.equal(s.crossMidnight, true);

  const day = resolveShift('2026-10-01', '08:00', '16:00');
  assert.equal(day.crossMidnight, false);
  assert.equal(day.end, '2026-10-01T16:00');
});

test('时段网格跨越午夜且保持左闭右开', () => {
  const slots = buildSlots('2026-10-01T23:00', '2026-10-02T01:00', 30);
  assert.equal(slots.length, 4);
  assert.deepEqual(slots[0], { start: '2026-10-01T23:00', end: '2026-10-01T23:30' });
  assert.deepEqual(slots[3], { start: '2026-10-02T00:30', end: '2026-10-02T01:00' });
  assert.equal(inSlot('2026-10-02T00:30', slots[3]), true);
  assert.equal(inSlot('2026-10-02T01:00', slots[3]), false);
});

test('非法时间被拒绝', () => {
  assert.throws(() => toMinutes('2026-13-01T20:00'));
  assert.throws(() => toMinutes('2026-10-01 20:00'));
});
