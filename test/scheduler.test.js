import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule, CERT } from '../src/scheduler.js';
import { buildSlots } from '../src/time.js';

const slots = buildSlots('2026-10-01T20:00', '2026-10-02T00:00', 30);
const shift = { startIso: '2026-10-01T19:30', endIso: '2026-10-02T00:30' };

const CONFIG = {
  slotMinutes: 30,
  smartThroughputPerSlot: 120,
  manualThroughputPerSlot: 45,
  maxContinuousMinutes: 120, // 测试中缩短为 4 个时段
  restMinutes: 30,
};

function demandFor(manualPerSlot, smartPerSlot) {
  return slots.map(() => ({
    entry: { manualPax: manualPerSlot, smartPax: smartPerSlot, totalPax: manualPerSlot + smartPerSlot, flights: [] },
    exit: { manualPax: 0, smartPax: 0, totalPax: 0, flights: [] },
  }));
}

const lanes = [
  { id: 'EM1', mode: 'manual', direction: 'entry' },
  { id: 'EM2', mode: 'manual', direction: 'entry' },
  { id: 'ES1', mode: 'smart', direction: 'entry', deviceId: 'D1' },
];
const devices = [{ id: 'D1', type: 'smart-gate', status: 'active' }];

test('无资质警力不会排上对应岗位', () => {
  const officers = [
    // 只有自助监管资质，没有人工查验资质
    { id: 'S1', certs: [CERT.smart], reserve: false, shift },
  ];
  const r = planSchedule({
    slots, demand: demandFor(40, 0), lanes, devices, officers,
    nowIso: '2026-10-01T19:59', config: CONFIG,
  });
  assert.equal(r.assignments.some((a) => lanes.find((l) => l.id === a.laneId).mode === 'manual'), false);
  assert.ok(r.gaps.some((g) => g.kind === 'staff' && g.mode === 'manual'));
});

test('连续执勤达上限后强制休息：单人警力第 5 时段必须离岗', () => {
  const officers = [
    { id: 'A', certs: [CERT.manual], reserve: false, shift },
  ];
  const r = planSchedule({
    slots, demand: demandFor(40, 0),
    lanes: [lanes[0]], devices, officers,
    nowIso: '2026-10-01T19:59', config: CONFIG,
  });
  // 前 4 个时段 A 连续执勤，第 5 个时段触发强制休息，岗位出现警力缺口。
  assert.deepEqual(
    r.assignments.filter((a) => a.slotIndex < 4).map((a) => a.officerId),
    ['A', 'A', 'A', 'A'],
  );
  assert.equal(r.assignments.some((a) => a.slotIndex === 4), false);
  assert.ok(r.gaps.some((g) => g.slotIndex === 4 && g.kind === 'staff' && g.mode === 'manual'));
});

test('两人警力均衡轮岗，且无人连续超过上限', () => {
  const officers = [
    { id: 'A', certs: [CERT.manual], reserve: false, shift },
    { id: 'B', certs: [CERT.manual], reserve: false, shift },
  ];
  const r = planSchedule({
    slots, demand: demandFor(40, 0),
    lanes: [lanes[0]], devices, officers,
    nowIso: '2026-10-01T19:59', config: CONFIG,
  });
  const byOfficer = { A: 0, B: 0 };
  for (const a of r.assignments) byOfficer[a.officerId] += 1;
  assert.ok(Math.abs(byOfficer.A - byOfficer.B) <= 1);
});

test('加急协查优先动用应急预留警力', () => {
  const officers = [
    { id: 'U1', certs: [CERT.urgent, CERT.manual], reserve: false, shift },
    { id: 'R1', certs: [CERT.urgent], reserve: true, shift },
  ];
  const urgentCases = [{
    caseId: 'C1', startIso: '2026-10-01T20:00', endIso: '2026-10-01T21:00',
    staffCount: 1, direction: null,
  }];
  const r = planSchedule({
    slots, demand: demandFor(40, 0),
    lanes: [lanes[0]], devices, officers, urgentCases,
    nowIso: '2026-10-01T19:59', config: CONFIG,
  });
  const c = r.urgentAssign.filter((u) => u.slotIndex < 2);
  assert.deepEqual(c.map((u) => u.officerIds), [['R1'], ['R1']]);
  // 预留上岗后，人工岗位由 U1 承担，未被协查挤占。
  assert.equal(r.assignments.find((a) => a.slotIndex === 0).officerId, 'U1');
});

test('协查缺员产生预留缺口', () => {
  const officers = [{ id: 'U1', certs: [CERT.urgent], reserve: false, shift }];
  const urgentCases = [{
    caseId: 'C1', startIso: '2026-10-01T20:00', endIso: '2026-10-01T20:30',
    staffCount: 2, direction: null,
  }];
  const r = planSchedule({
    slots, demand: demandFor(0, 0), lanes, devices, officers, urgentCases,
    nowIso: '2026-10-01T19:59', config: CONFIG,
  });
  assert.ok(r.gaps.some((g) => g.kind === 'reserve' && g.required === 2 && g.assigned === 1));
});

test('设备停用时段自助通道关闭', () => {
  const officers = [
    { id: 'S1', certs: [CERT.smart], reserve: false, shift },
    { id: 'M1', certs: [CERT.manual], reserve: false, shift },
  ];
  const outages = new Map([['D1', [{ fromIso: '2026-10-01T21:00', toIso: null }]]]);
  const r = planSchedule({
    slots, demand: demandFor(0, 100), lanes, devices, officers, outages,
    nowIso: '2026-10-01T19:59', config: CONFIG,
  });
  // 20:00-20:30 自助开放；21:00 起设备停用，自助不再开放。
  assert.ok(r.assignments.some((a) => a.slotIndex === 0 && a.laneId === 'ES1'));
  assert.equal(r.assignments.some((a) => a.slotIndex >= 2 && a.laneId === 'ES1'), false);
  assert.ok(r.gaps.some((g) => g.kind === 'device' && g.slotIndex >= 2));
});

test('已开始时段冻结：既有的通道安排原样保留', () => {
  const officers = [
    { id: 'A', certs: [CERT.manual], reserve: false, shift },
    { id: 'B', certs: [CERT.manual], reserve: false, shift },
  ];
  // 20:00 与 20:30 两时段已开始，历史安排固定 B 在 EM1。
  const frozenLaneAssign = new Map([
    [0, [{ laneId: 'EM1', officerId: 'B' }]],
    [1, [{ laneId: 'EM1', officerId: 'B' }]],
  ]);
  const r = planSchedule({
    slots, demand: demandFor(40, 0),
    lanes: [lanes[0]], devices, officers, frozenLaneAssign,
    nowIso: '2026-10-01T20:35', config: CONFIG,
  });
  const frozen = r.assignments.filter((a) => a.slotIndex < 2);
  assert.ok(frozen.every((a) => a.officerId === 'B' && a.frozen === true));
  assert.equal(r.frozenCount, 2);
});
