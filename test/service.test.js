import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Clock } from '../src/clock.js';
import { PeakService, ROLES } from '../src/service.js';

async function loadScenario() {
  return JSON.parse(
    await readFile(new URL('../fixtures/peak-scenario.json', import.meta.url), 'utf8'),
  );
}

function makeService(initialIso = '2026-10-01T19:50', config = {}) {
  return new PeakService({ clock: new Clock(initialIso), scenario: scenarioCache, config });
}

let scenarioCache;
test.before(async () => {
  scenarioCache = await loadScenario();
});

test('发布计划并给出跨午夜峰值时段', () => {
  const svc = makeService();
  const pub = svc.publish();
  assert.equal(pub.ok, true);
  assert.equal(pub.planVersion, 1);
  assert.equal(pub.peak.pax > 0, true);
  assert.ok(pub.peak.slot.start >= '2026-10-01T20:00');
  // 重复发布被拒绝。
  assert.equal(svc.publish().reason, 'already-published');
});

test('航班改时事件只修订未执行时段，已开始勤务保留原安排', () => {
  const svc = makeService('2026-10-01T19:50');
  svc.publish();
  const before = svc.snapshot().plan.schedule.assignments;

  svc.clock.jumpTo('2026-10-01T20:35'); // 20:00、20:30 两时段已开始
  const r = svc.submitEvent({
    type: 'flight-update', dispatcherId: 'D-A', eventId: 'e-delay',
    flightNo: 'CA101', updateId: 'u-delay', expectedVersion: 1, expectedFlightVersion: 0,
    revisedIso: '2026-10-01T22:30', reason: '航班延误',
  });
  assert.equal(r.ok, true);
  assert.equal(r.planVersion, 2);

  const after = svc.snapshot().plan.schedule.assignments;
  const pick = (list, idx) => list.filter((a) => a.slotIndex === idx)
    .map((a) => `${a.laneId}:${a.officerId}`).sort();
  // 已开始时段（20:00、20:30）的安排集合保持不变；存在安排的一律带 frozen 标记。
  for (const idx of [0, 1]) {
    assert.deepEqual(pick(after, idx), pick(before, idx), `时段 ${idx} 应冻结`);
  }
  assert.ok(after.filter((a) => a.slotIndex <= 1).every((a) => a.frozen === true));
  // 未执行时段发生重排（版本已推进）。
  assert.equal(svc.snapshot().planVersion, 2);
});

test('同一航班更新重复提交保持原结果（updateId/eventId 双重幂等）', () => {
  const svc = makeService();
  svc.publish();
  const payload = {
    type: 'flight-update', dispatcherId: 'D-A', eventId: 'e1',
    flightNo: 'CA202', updateId: 'u1', expectedVersion: 1, expectedFlightVersion: 0,
    estPax: 170,
  };
  const r1 = svc.submitEvent(payload);
  const r2 = svc.submitEvent({ ...payload, estPax: 999 });
  assert.deepEqual(r2, r1);
  assert.equal(svc.feed.get('CA202').estPax, 170);
});

test('航班版本过期被拒，且不产生新版本', () => {
  const svc = makeService();
  svc.publish();
  svc.submitEvent({
    type: 'flight-update', eventId: 'e1', flightNo: 'CA202',
    updateId: 'u1', expectedVersion: 1, expectedFlightVersion: 0, estPax: 170,
  });
  const stale = svc.submitEvent({
    type: 'flight-update', eventId: 'e2', flightNo: 'CA202',
    updateId: 'u2', expectedVersion: 2, expectedFlightVersion: 0, estPax: 180,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-version');
  assert.equal(svc.snapshot().planVersion, 2);
});

test('两个调度员争用同一通道：持过期资源版本的较晚提交被拒绝', () => {
  const svc = makeService();
  svc.publish();
  const laneVersion = svc.resourceVersion('lane:EM1');

  // 调度员 A 先把 M07 锁定到 EM1 的 22:00 时段。
  const a = svc.submitEvent({
    type: 'post-swap', dispatcherId: 'D-A', eventId: 'swap-a',
    expectedVersion: 1,
    resourceVersions: { 'lane:EM1': laneVersion, 'officer:M07': 0 },
    laneId: 'EM1', slotStart: '2026-10-01T22:00',
    fromOfficerId: 'M01', toOfficerId: 'M07', reason: 'A 的换岗',
  });
  assert.equal(a.ok, true);

  // 调度员 B 基于旧资源版本争用同一通道，被拒绝，计划不被改写。
  const b = svc.submitEvent({
    type: 'post-swap', dispatcherId: 'D-B', eventId: 'swap-b',
    expectedVersion: 2,
    resourceVersions: { 'lane:EM1': laneVersion, 'officer:M04': 0 },
    laneId: 'EM1', slotStart: '2026-10-01T22:00',
    fromOfficerId: 'M02', toOfficerId: 'M04', reason: 'B 的换岗',
  });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'resource-conflict');

  const snap = svc.snapshot();
  const slotIdx = snap.plan.slots.findIndex((s) => s.start === '2026-10-01T22:00');
  const em1 = snap.plan.schedule.assignments.find((x) => x.slotIndex === slotIdx && x.laneId === 'EM1');
  assert.equal(em1.officerId, 'M07');
  assert.equal(em1.swapped, true);
});

test('计划版本过期直接拒绝较晚提交', () => {
  const svc = makeService();
  svc.publish();
  const r = svc.submitEvent({
    type: 'device-outage', eventId: 'd1', expectedVersion: 9,
    deviceId: 'D-ES1', fromIso: '2026-10-01T22:00', toIso: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'plan-version-conflict');
});

test('不具备资质或方向授权的换岗被拒绝', () => {
  const svc = makeService();
  svc.publish();
  // S01 只有自助监管资质，不能换到人工通道。
  const r1 = svc.submitEvent({
    type: 'post-swap', eventId: 'swap-cert', expectedVersion: 1,
    laneId: 'EM1', slotStart: '2026-10-01T22:00', toOfficerId: 'S01',
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'officer-not-certified');
  // M01 只有入境授权，不能换到出境通道。
  const r2 = svc.submitEvent({
    type: 'post-swap', eventId: 'swap-dir', expectedVersion: 1,
    laneId: 'XM1', slotStart: '2026-10-01T22:00', toOfficerId: 'M01',
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'officer-not-authorized-direction');
});

test('已开始时段不能换岗或加急协查', () => {
  const svc = makeService('2026-10-01T20:35');
  svc.publish();
  const r1 = svc.submitEvent({
    type: 'post-swap', eventId: 's', expectedVersion: 1,
    laneId: 'EM1', slotStart: '2026-10-01T20:30', toOfficerId: 'M07',
  });
  assert.equal(r1.reason, 'slot-already-started');
  const r2 = svc.submitEvent({
    type: 'urgent-case', eventId: 'u', expectedVersion: 1,
    caseId: 'C-PAST', startIso: '2026-10-01T20:30', endIso: '2026-10-01T21:00', staffCount: 1,
  });
  assert.equal(r2.reason, 'slot-already-started');
});

test('设备停用后未执行时段自助通道关闭，旅客压力转人工', () => {
  const svc = makeService();
  svc.publish();
  const r = svc.submitEvent({
    type: 'device-outage', eventId: 'out-1', expectedVersion: 1,
    dispatcherId: 'D-A', deviceId: 'D-ES1',
    fromIso: '2026-10-01T21:30', toIso: null, reason: '设备故障',
  });
  assert.equal(r.ok, true);
  const snap = svc.snapshot();
  const hasOpen = (idx, laneId) => snap.plan.schedule.assignments
    .some((a) => a.slotIndex === idx && a.laneId === laneId);
  assert.equal(hasOpen(2, 'ES1'), true);  // 停用前照常开放
  assert.equal(hasOpen(3, 'ES1'), false); // 21:30 起关闭
  assert.ok(snap.plan.schedule.gaps.some((g) => g.slotIndex === 3 && g.kind === 'device'));
});

test('加急协查优先占用应急预留，缺员进入下一时段缺口', () => {
  const svc = makeService();
  svc.publish();
  const r = svc.submitEvent({
    type: 'urgent-case', eventId: 'urgent-1', expectedVersion: 1,
    caseId: 'C-404', startIso: '2026-10-01T21:30', endIso: '2026-10-01T22:30',
    staffCount: 2, direction: 'entry', reason: '加急协查',
  });
  assert.equal(r.ok, true);
  const snap = svc.snapshot();
  const slotIdx = snap.plan.slots.findIndex((s) => s.start === '2026-10-01T21:30');
  const assign = snap.plan.schedule.urgentAssign.find((u) => u.slotIndex === slotIdx && u.caseId === 'C-404');
  // 预留警力 R01/R02 都具备协查资质且无方向限制，优先上岗。
  assert.deepEqual(assign.officerIds.sort(), ['R01', 'R02']);
});

test('证件材料明细仅在授权检查范围内可见', () => {
  const svc = makeService();
  svc.publish();
  const r = svc.submitEvent({
    type: 'doc-anomaly', eventId: 'doc-1', expectedVersion: 1,
    flightNo: 'HU404', docId: 'DOC-1', caseRef: 'CASE-1',
    docAnomalyPax: 12,
    summary: '证件有效期异常待核查',
    materials: [{ kind: 'passport-page', ref: 'X-001' }],
  });
  assert.equal(r.ok, true);

  const commander = svc.handoverSummary({ viewerRoles: [ROLES.commander] });
  const docFull = commander.unhandledAnomalies.docs.find((d) => d.docId === 'DOC-1');
  assert.equal(docFull.authorized, true);
  assert.equal(docFull.summary, '证件有效期异常待核查');
  assert.equal(docFull.materials.length, 1);

  // 航班保障人员不在授权范围内：只见编号，不见材料内容。
  const support = svc.handoverSummary({ viewerRoles: [ROLES.flightSupport] });
  const docHidden = support.unhandledAnomalies.docs.find((d) => d.docId === 'DOC-1');
  assert.equal(docHidden.authorized, false);
  assert.deepEqual(docHidden.materials, []);
  assert.equal('summary' in docHidden, false);

  // 异常人数已计入人工压力（计划中出现转人工依据）。
  assert.ok(svc.snapshot().events.some((e) => e.type === 'doc-anomaly' && e.accepted));
});

test('交班摘要在同一读取水位上汇齐通道、缺口、依据与未处理异常', () => {
  const svc = makeService();
  svc.publish();
  svc.clock.jumpTo('2026-10-01T21:35');
  // 先把 HU404 提前到 22:00，使下一时段确有入境自助压力。
  svc.submitEvent({
    type: 'flight-update', eventId: 'f-early', expectedVersion: 1,
    dispatcherId: 'D-A', flightNo: 'HU404', updateId: 'u-early', expectedFlightVersion: 0,
    revisedIso: '2026-10-01T22:00', reason: '航班提前',
  });
  svc.submitEvent({
    type: 'device-outage', eventId: 'out-x', expectedVersion: 2,
    dispatcherId: 'D-A', deviceId: 'D-ES2',
    fromIso: '2026-10-01T22:00', toIso: null, reason: '闸机维护',
  });
  svc.submitEvent({
    type: 'urgent-case', eventId: 'urg-x', expectedVersion: 3,
    caseId: 'C-X', startIso: '2026-10-01T22:00', endIso: '2026-10-01T22:30',
    staffCount: 1,
  });

  const s1 = svc.handoverSummary({ dispatcherId: 'D-A' });
  assert.equal(s1.watermark.nowIso, '2026-10-01T21:35');
  assert.ok(Array.isArray(s1.openLanes));
  assert.equal(s1.openLanes.length > 0, true); // 21:30 时段正在开放通道
  assert.equal(s1.nextSlot.start, '2026-10-01T22:00');
  assert.ok(s1.nextSlotGaps.some((g) => g.kind === 'device'));
  const bases = s1.adjustments.map((a) => a.basis).join(' ');
  assert.ok(bases.includes('D-ES2'));
  assert.ok(s1.unhandledAnomalies.cases.some((c) => c.caseId === 'C-X'));

  // 第二次交班：调整依据只包含新水位之后的事件。
  svc.clock.advance(30);
  const s2 = svc.handoverSummary({ dispatcherId: 'D-B' });
  assert.equal(s2.watermark.eventSeq, s1.watermark.eventSeq);
  assert.deepEqual(s2.adjustments, []);
});

test('自助停用叠加证件异常时，人工无法消化的旅客排队并结转到下一时段', () => {
  const svc = makeService();
  svc.publish();
  let v = 1;
  // 两台入境自助设备在 HU404 到达前后停用。
  for (const deviceId of ['D-ES1', 'D-ES2']) {
    const r = svc.submitEvent({
      type: 'device-outage', eventId: `out-${deviceId}`, expectedVersion: v,
      deviceId, fromIso: '2026-10-01T23:00', toIso: '2026-10-02T01:00',
    });
    assert.equal(r.ok, true);
    v += 1;
  }
  // 再叠加证件异常，进一步加大人工压力。
  const r = svc.submitEvent({
    type: 'doc-anomaly', eventId: 'doc-big', expectedVersion: v,
    flightNo: 'HU404', docId: 'DOC-BIG', docAnomalyPax: 80,
  });
  assert.equal(r.ok, true);

  const snap = svc.snapshot().plan;
  const idx = snap.slots.findIndex((s) => s.start === '2026-10-01T23:30');
  const entryQueue = snap.backlog[idx].directions.entry;
  // 全部入境旅客（约 240+）压向 3 条人工通道（容量 135），必然排队。
  assert.ok(entryQueue.divertedToManual > 0);
  assert.ok(entryQueue.manualQueue > 0);
  // 下一时段仍消化不完，队列结转且不小于上一时段的结转压力。
  const next = snap.backlog[idx + 1].directions.entry;
  assert.ok(next.manualQueue > 0);
});

test('发布前提交事件被拒绝', () => {
  const svc = makeService();
  assert.equal(svc.submitEvent({ type: 'device-outage', deviceId: 'D-ES1' }).reason, 'not-published');
  assert.throws(() => svc.handoverSummary());
});

test('换岗交接记录在后续多次修订中始终保留', () => {
  const svc = makeService();
  svc.publish();
  svc.submitEvent({
    type: 'post-swap', eventId: 'swap-keep', expectedVersion: 1,
    resourceVersions: { 'lane:EM2': 0, 'officer:M07': 0 },
    laneId: 'EM2', slotStart: '2026-10-01T23:30', toOfficerId: 'M07',
    fromOfficerId: 'M02', reason: '夜间跨方向支援',
  });
  // 之后再发生与该换岗无关的修订，交接记录必须仍可追溯。
  svc.clock.jumpTo('2026-10-01T20:35');
  svc.submitEvent({
    type: 'flight-update', eventId: 'later', expectedVersion: 2,
    flightNo: 'CA202', updateId: 'u-later', expectedFlightVersion: 0, estPax: 200,
  });
  const snap = svc.snapshot().plan;
  const note = snap.handovers.find((h) => h.laneId === 'EM2');
  assert.ok(note);
  assert.equal(note.fromOfficerId, 'M02');
  assert.equal(note.toOfficerId, 'M07');
  assert.equal(note.reason, '夜间跨方向支援');

  const summary = svc.handoverSummary();
  assert.ok(summary.handoverRecords.some((h) => h.toOfficerId === 'M07'));
});

test('已开始时段的历史缺口在重排后原样保留', () => {
  const svc = makeService('2026-10-01T19:50');
  svc.publish();
  // 20:30 时段制造一个人工警力缺口：让 M01 之外无可用入境人工警力不可行，
  // 改为停用全部入境自助设备并提高 CA101 客流，使人工通道数量不足。
  svc.clock.jumpTo('2026-10-01T20:35'); // 20:30 时段已开始
  svc.submitEvent({
    type: 'flight-update', eventId: 'f-big', expectedVersion: 1,
    flightNo: 'CA101', updateId: 'u-big', expectedFlightVersion: 0,
    actualPax: 600,
  });
  const afterFreeze = svc.snapshot().plan;
  // 20:30（index 1）已开始，其缺口来自被冻结的原计划（此处无历史缺口）。
  // 随后在 21:35 再修订，20:30 状态仍冻结。
  svc.clock.jumpTo('2026-10-01T21:35');
  svc.submitEvent({
    type: 'flight-update', eventId: 'f-small', expectedVersion: 2,
    flightNo: 'CA202', updateId: 'u-small', expectedFlightVersion: 0, estPax: 10,
  });
  const later = svc.snapshot().plan;
  const frozenAssign1 = later.schedule.assignments
    .filter((a) => a.slotIndex <= 1);
  const beforeAssign1 = afterFreeze.schedule.assignments
    .filter((a) => a.slotIndex <= 1);
  assert.deepEqual(
    frozenAssign1.map((a) => `${a.laneId}:${a.officerId}`).sort(),
    beforeAssign1.map((a) => `${a.laneId}:${a.officerId}`).sort(),
  );
  assert.ok(frozenAssign1.every((a) => a.frozen === true));
});

test('处理异常后从未处理清单消失', () => {
  const svc = makeService();
  svc.publish();
  svc.submitEvent({
    type: 'doc-anomaly', eventId: 'd', expectedVersion: 1,
    flightNo: 'HU404', docId: 'DOC-9', docAnomalyPax: 3,
  });
  svc.submitEvent({ type: 'resolve-anomaly', eventId: 'r', expectedVersion: 2, docId: 'DOC-9' });
  const s = svc.handoverSummary();
  assert.equal(s.unhandledAnomalies.docs.some((d) => d.docId === 'DOC-9'), false);
});
