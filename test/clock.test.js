import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from '../src/clock.js';

test('时钟从固定时间起步，只能向前', () => {
  const c = new Clock('2026-10-01T23:45');
  assert.equal(c.now(), '2026-10-01T23:45');
  assert.equal(c.advance(20), '2026-10-02T00:05');
  assert.throws(() => c.advance(-1));
  assert.throws(() => c.jumpTo('2026-10-02T00:00'));
  assert.equal(c.jumpTo('2026-10-02T00:10'), '2026-10-02T00:10');
});

test('时钟必须给定初始时间', () => {
  assert.throws(() => new Clock());
});
