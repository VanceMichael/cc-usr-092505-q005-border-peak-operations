// 用固定航班与固定时钟重放一次完整的双节高峰，不接入真实机场设备。
// 时间线（UTC，2026-10-01 国庆当日）：
//   18:00 发布计划（窗口 18:00 → 次日 02:00，跨午夜）
//   19:05 航班改时（F3 从 23:30 改到 00:30）→ 只修订未执行时段
//   19:05 重复同一航班更新 → 保持原结果
//   19:05 更旧的航班版本 → 拒绝
//   19:05 设备停用（智能通道下线）→ 未执行时段重排
//   19:05 另一调度员持旧 revision 提交 → 拒绝较晚版本
//   19:20 岗位换班（资质校验）
//   19:20 加急协查 → 抽调应急预留
//   19:20 交班摘要 → 四个小节同一读取水位
//   19:20 临时增开通道 → 客流缺口补齐
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock } from '../src/clock.js';
import { makeFlight, makeLane, makeDevice, makeOfficer, makeShift } from '../src/model.js';
import { createDutyService, ConflictError, StaleVersionError } from '../src/service.js';

const T = (day, h, m = 0) => Date.UTC(2026, 9, day, h, m);
const SLOT = 30 * 60 * 1000;

function buildService() {
  const clock = fixedClock(T(1, 18, 0));
  const service = createDutyService({ clock, slotMs: SLOT, reserveCount: 1 });
  service.registerResources({
    lanes: [
      makeLane({ id: 'L1', kind: 'manual', directions: ['entry', 'exit'], capacityPerSlot: 60 }),
      makeLane({ id: 'L2', kind: 'manual', directions: ['entry', 'exit'], capacityPerSlot: 60 }),
      makeLane({ id: 'S1', kind: 'smart', directions: ['entry'], deviceIds: ['D1'], capacityPerSlot: 120 }),
    ],
    devices: [makeDevice({ id: 'D1', kind: 'smart-gate' })],
    officers: [
      makeOfficer({ id: 'O1', qualifications: ['manual', 'lead'] }),
      makeOfficer({ id: 'O2', qualifications: ['manual', 'smart'] }),
      makeOfficer({ id: 'O3', qualifications: ['manual', 'smart', 'assist'] }),
      makeOfficer({ id: 'O4', qualifications: ['manual', 'assist'] }),
      makeOfficer({ id: 'O5', qualifications: ['smart', 'assist', 'lead'] }),
      makeOfficer({ id: 'O6', qualifications: ['manual'] }),
    ],
    // 跨午夜班次：18:00 上岗、次日 02:00 下岗。
    shifts: [1, 2, 3, 4, 5, 6].map((n) =>
      makeShift({ officerId: `O${n}`, startMs: T(1, 18, 0), endMs: T(2, 2, 0), maxContinuousMin: 240 }),
    ),
    documents: [
      { id: 'DOC1', scope: 'entry-inspection', summary: '入境旅客护照有效期不足六个月' },
      { id: 'DOC2', scope: 'exit-inspection', summary: '出境旅客签注次数异常' },
      { id: 'DOC3', scope: 'assist-case', summary: '协查对象证件芯片读取失败' },
    ],
  });
  return { clock, service };
}

const FLIGHTS = [
  { id: 'F1', version: 1, direction: 'entry', scheduledMs: T(1, 19, 0), estimatedPax: 200 },
  { id: 'F2', version: 10, direction: 'exit', scheduledMs: T(1, 21, 30), estimatedPax: 150 },
  { id: 'F3', version: 1, direction: 'entry', scheduledMs: T(1, 23, 30), estimatedPax: 180 },
];

function slotAt(plan, ms) {
  return plan.slots.find((s) => s.startMs === ms);
}

function officerOf(plan, ms, laneId) {
  return slotAt(plan, ms)?.posts.find((p) => p.laneId === laneId)?.officerId ?? null;
}

test('固定航班与时钟重放一次完整高峰', () => {
  const { clock, service } = buildService();

  // ---- 18:00 发布计划 ----
  const published = service.publishPlan({ fromMs: T(1, 18, 0), toMs: T(2, 2, 0), flights: FLIGHTS });
  assert.equal(published.revision, 1);
  // 跨午夜：次日 00:00 之后的槽位已排入计划且人员到岗。
  const afterMidnight = slotAt(published, T(2, 0, 0));
  assert.ok(afterMidnight, '跨午夜槽位应存在');
  assert.ok(afterMidnight.posts.every((p) => p.officerId !== null), '跨午夜槽位应全部到岗');
  // 资质与班次约束：所有上岗人员具备岗位资质，且无人同一槽位双岗。
  const quals = { O1: ['manual', 'lead'], O2: ['manual', 'smart'], O3: ['manual', 'smart', 'assist'], O4: ['manual', 'assist'], O5: ['smart', 'assist', 'lead'], O6: ['manual'] };
  for (const slot of published.slots) {
    const seen = new Set();
    for (const post of slot.posts) {
      if (!post.officerId) continue;
      assert.ok(quals[post.officerId].includes(post.requiredQual), `${post.officerId} 不具备 ${post.requiredQual}`);
      assert.ok(!seen.has(post.officerId), `${post.officerId} 同一槽位重复上岗`);
      seen.add(post.officerId);
    }
  }
  // 峰值用注入时钟计算：18:00 之后最高峰在 19:00/19:30（100 人）。
  assert.deepEqual(service.upcomingPeak(), { slotStartMs: T(1, 19, 0), totalPax: 100 });

  // ---- 19:05 航班改时：只修订未执行时段 ----
  clock.advance(65 * 60 * 1000); // 18:00 → 19:05，19:00 槽位已开始
  const lockedBefore = slotAt(service.snapshotPlan(), T(1, 19, 0));
  const retimed = service.applyFlightUpdate(
    { id: 'F3', version: 2, direction: 'entry', scheduledMs: T(2, 0, 30), estimatedPax: 180 },
    { expectedRevision: 1 },
  );
  assert.equal(retimed.applied, true);
  assert.equal(retimed.revision, 2);
  let plan = service.snapshotPlan();
  // 已开始的 19:00 槽位保留原安排。
  assert.deepEqual(slotAt(plan, T(1, 19, 0)), lockedBefore);
  // 旧时刻 23:30 的槽位撤销，新时刻 00:30 出现。
  assert.equal(slotAt(plan, T(1, 23, 30)), undefined);
  assert.ok(slotAt(plan, T(2, 0, 30)), '改时后的航班应在 00:30 产生需求');
  // 交接记录：重排时已执行槽位的安排被留存。
  assert.ok(plan.handoverLog.length > 0);

  // ---- 重复航班更新保持原结果 ----
  const replay = service.applyFlightUpdate(
    { id: 'F3', version: 2, direction: 'entry', scheduledMs: T(2, 0, 30), estimatedPax: 180 },
    { expectedRevision: 1 }, // 重试带着旧 revision 也应命中幂等
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 2);
  assert.equal(service.snapshotPlan().revision, 2, '重复更新不得产生新修订');
  assert.equal(service.snapshotPlan().adjustments.length, 1);

  // ---- 更旧的航班版本被拒绝 ----
  assert.throws(
    () => service.applyFlightUpdate(
      { id: 'F2', version: 9, direction: 'exit', scheduledMs: T(1, 22, 0), estimatedPax: 150 },
      { expectedRevision: 2 },
    ),
    StaleVersionError,
  );

  // ---- 设备停用：智能通道退出未执行时段 ----
  const outage = service.setDeviceActive('D1', false, { expectedRevision: 2 });
  assert.equal(outage.revision, 3);
  plan = service.snapshotPlan();
  assert.equal(service.laneUsable('S1'), false);
  for (const slot of plan.slots) {
    if (slot.startMs <= clock.now()) continue; // 已开始的保留原安排
    assert.ok(!slot.posts.some((p) => p.laneId === 'S1'), '设备停用后智能通道不得再排岗');
  }
  // 已开始的 19:00 槽位仍保留 S1 的原安排与交接记录。
  assert.equal(officerOf(plan, T(1, 19, 0), 'S1'), 'O2');

  // ---- 两个调度员争用：较晚版本被拒绝 ----
  const somePost = slotAt(plan, T(1, 19, 30)).posts.find((p) => p.laneId === 'L1');
  assert.throws(
    () => service.swapPost(somePost.id, 'O6', { expectedRevision: 2 }),
    ConflictError,
  );
  assert.equal(service.snapshotPlan().revision, 3, '冲突提交不得改变计划');

  // ---- 岗位换班：资质校验 ----
  clock.advance(15 * 60 * 1000); // 19:05 → 19:20
  // 不具备人工查验资质的人员不能换到人工通道岗。
  assert.throws(
    () => service.swapPost(somePost.id, 'O5', { expectedRevision: 3 }),
    /不具备岗位所需资质/,
  );
  // 已开始槽位保留原安排，拒绝换班。
  const lockedPost = slotAt(plan, T(1, 19, 0)).posts.find((p) => p.laneId === 'S1');
  assert.throws(
    () => service.swapPost(lockedPost.id, 'O6', { expectedRevision: 3 }),
    ConflictError,
  );
  // 合规换班成功。
  const swapped = service.swapPost(somePost.id, 'O6', { expectedRevision: 3 });
  assert.equal(swapped.revision, 4);
  assert.equal(officerOf(service.snapshotPlan(), T(1, 19, 30), 'L1'), 'O6');

  // ---- 加急协查：抽调应急预留 ----
  const assist = service.reportAnomaly(
    { kind: '证件异常', detail: '旅客证件芯片读取失败，需人工复核' },
    { expectedRevision: 4 },
  );
  assert.equal(assist.anomaly.status, 'assigned');
  assert.equal(assist.anomaly.assigneeOfficerId, 'O3'); // 当前槽位应急预留岗
  assert.equal(assist.revision, 5);

  // ---- 证件材料只在授权检查范围内可见 ----
  assert.deepEqual(
    service.visibleDocuments(['entry-inspection']).map((d) => d.id),
    ['DOC1'],
  );
  assert.deepEqual(
    service.visibleDocuments(['entry-inspection', 'assist-case']).map((d) => d.id),
    ['DOC1', 'DOC3'],
  );
  assert.deepEqual(service.visibleDocuments([]), []);

  // ---- 交班摘要：四个小节同一读取水位 ----
  const summary = service.handoverSummary();
  assert.equal(summary.watermark.revision, 5);
  assert.equal(summary.watermark.atMs, clock.now());
  // 正在开放的通道：19:00–19:30 槽位的 S1（已开始，保留原安排）。
  assert.deepEqual(summary.openLanes, [{ laneId: 'S1', direction: 'entry', officerId: 'O2' }]);
  // 下一时段缺口：设备停用后 19:30 入境客流超出人工通道能力。
  assert.equal(summary.nextGaps.length, 1);
  assert.equal(summary.nextGaps[0].startMs, T(1, 19, 30));
  assert.equal(summary.nextGaps[0].unmetPax.entry, 10);
  // 临时调整依据：改时、停用、换班、协查各一条。
  const reasons = summary.adjustments.map((a) => a.reason).join('\n');
  assert.match(reasons, /航班 F3 更新/);
  assert.match(reasons, /设备 D1 停用/);
  assert.match(reasons, /换为 O6/);
  assert.match(reasons, /加急协查/);
  // 未处理异常。
  assert.deepEqual(summary.unhandledAnomalies.map((a) => a.id), ['A1']);

  // ---- 临时增开通道：补齐客流缺口 ----
  const opened = service.openLane(
    makeLane({ id: 'L3', kind: 'manual', directions: ['entry', 'exit'], capacityPerSlot: 60 }),
    { expectedRevision: 5 },
  );
  assert.equal(opened.revision, 6);
  const afterOpen = service.handoverSummary();
  assert.equal(afterOpen.watermark.revision, 6);
  assert.deepEqual(afterOpen.nextGaps, [], '增开通道后缺口应补齐');

  // ---- 异常办结后从摘要中移除 ----
  service.resolveAnomaly('A1');
  assert.deepEqual(service.handoverSummary().unhandledAnomalies, []);
});
