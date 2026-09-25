import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightFeed, projectDemand, peakSlot, paxOf } from '../src/flights.js';
import { buildSlots } from '../src/time.js';

const CONFIG = {
  arrivalWindowMinutes: 60,
  departureLeadMinutes: 90,
  smartEligibleShare: 0.7,
};

function feed() {
  return new FlightFeed([
    { flightNo: 'CA1', direction: 'arrival', scheduledIso: '2026-10-01T20:00', estPax: 100 },
  ]);
}

test('航班更新必须携带正确版本，版本递增', () => {
  const f = feed();
  const r1 = f.applyUpdate({ flightNo: 'CA1', updateId: 'u1', expectedVersion: 0, estPax: 120 });
  assert.equal(r1.ok, true);
  assert.equal(r1.version, 1);
  assert.equal(f.get('CA1').estPax, 120);

  const stale = f.applyUpdate({ flightNo: 'CA1', updateId: 'u2', expectedVersion: 0, estPax: 130 });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-version');
  assert.equal(stale.currentVersion, 1);
  assert.equal(f.get('CA1').estPax, 120);
});

test('重复 updateId 幂等：重放保持原结果', () => {
  const f = feed();
  const payload = { flightNo: 'CA1', updateId: 'dup', expectedVersion: 0, estPax: 140 };
  const r1 = f.applyUpdate(payload);
  const r2 = f.applyUpdate({ ...payload, estPax: 999 });
  assert.deepEqual(r2, r1);
  assert.equal(f.get('CA1').estPax, 140);

  // 被拒绝的更新重放也返回同一个拒绝。
  const s1 = f.applyUpdate({ flightNo: 'CA1', updateId: 'stale1', expectedVersion: 0, estPax: 1 });
  const s2 = f.applyUpdate({ flightNo: 'CA1', updateId: 'stale1', expectedVersion: 1, estPax: 1 });
  assert.equal(s1.ok, false);
  assert.deepEqual(s2, s1);
});

test('实际客流到位后替代预计客流', () => {
  const f = feed();
  assert.equal(paxOf(f.get('CA1')), 100);
  f.applyUpdate({ flightNo: 'CA1', updateId: 'a', expectedVersion: 0, actualPax: 105 });
  assert.equal(paxOf(f.get('CA1')), 105);
});

test('入境压力窗为到达后 60 分钟；出境为起飞前 90 分钟', () => {
  const slots = buildSlots('2026-10-01T19:30', '2026-10-01T22:00', 30);
  const f = new FlightFeed([
    { flightNo: 'IN1', direction: 'arrival', scheduledIso: '2026-10-01T20:00', estPax: 200 },
    { flightNo: 'OUT1', direction: 'departure', scheduledIso: '2026-10-01T22:00', estPax: 200 },
  ]);
  const demand = projectDemand(f, slots, CONFIG);
  const entrySlots = demand.map((d, i) => d.entry.totalPax ? i : null).filter((i) => i !== null);
  const exitSlots = demand.map((d, i) => d.exit.totalPax ? i : null).filter((i) => i !== null);
  assert.deepEqual(entrySlots, [1, 2]); // 20:00-21:00
  assert.deepEqual(exitSlots, [2, 3, 4]); // 20:30-22:00
  // 各时段合计等于总人数（取整守恒）。
  assert.equal(demand.reduce((a, d) => a + d.entry.totalPax, 0), 200);
  assert.equal(demand.reduce((a, d) => a + d.exit.totalPax, 0), 200);
});

test('证件异常旅客全部计入人工通道', () => {
  const slots = buildSlots('2026-10-01T20:00', '2026-10-01T21:00', 60);
  const f = new FlightFeed([
    { flightNo: 'IN1', direction: 'arrival', scheduledIso: '2026-10-01T20:00',
      estPax: 100, docAnomalyPax: 20 },
  ]);
  const [d] = projectDemand(f, slots, CONFIG);
  assert.equal(d.entry.totalPax, 100);
  // 普通 80 人中自助 0.7 => 56，人工 24；异常 20 人全人工。
  assert.equal(d.entry.smartPax, 56);
  assert.equal(d.entry.manualPax, 44);
});

test('航班改时后峰值随之移动（跨午夜）', () => {
  const slots = buildSlots('2026-10-01T23:00', '2026-10-02T02:00', 30);
  const f = new FlightFeed([
    { flightNo: 'LATE', direction: 'arrival', scheduledIso: '2026-10-01T23:30', estPax: 300 },
  ]);
  const before = peakSlot(slots, projectDemand(f, slots, CONFIG));
  f.applyUpdate({ flightNo: 'LATE', updateId: 'delay', expectedVersion: 0,
    revisedIso: '2026-10-02T01:00' });
  const after = peakSlot(slots, projectDemand(f, slots, CONFIG));
  assert.notEqual(after.slot.start, before.slot.start);
  assert.ok(after.slot.start >= '2026-10-02T01:00');
});
