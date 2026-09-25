// 勤务服务：计划的发布与事件修订。
// 关键语义：
// - 计划按 revision 做乐观并发：命令携带 expectedRevision，不一致即拒绝较晚版本。
// - 航班更新按 (航班号, 版本) 幂等：重复提交返回首次结果，不产生新修订。
// - 已开始（startMs <= now）的槽位冻结，保留原安排与交接记录；事件只修订未执行时段。
// - 证件材料按授权检查范围过滤，范围外不可见。
// - 交班摘要在同一读取水位（同一 revision + 同一 now）上取数。

import { slotStartOf } from './clock.js';
import {
  demandBySlot,
  effectivePax,
  laneUsable,
  longestContinuousMin,
  makeFlight,
} from './model.js';
import { planDuty } from './planner.js';

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class StaleVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

export function createDutyService({ clock, slotMs = 30 * 60 * 1000, reserveCount = 1 }) {
  if (!clock || typeof clock.now !== 'function') throw new Error('必须注入时钟');

  const state = {
    flights: new Map(), // id -> 最新航班版本
    flightResults: new Map(), // `${id}@${version}` -> 首次应用结果（幂等）
    lanes: new Map(),
    devices: new Map(),
    officers: new Map(),
    shifts: [],
    documents: [], // { id, scope, summary }
    anomalies: [], // { id, kind, slotStartMs, detail, status, assigneeOfficerId }
    anomalySeq: 0,
    plan: null, // { revision, windowMs, slots, adjustments, handoverLog }
  };

  const now = () => clock.now();

  function registerResources({ lanes = [], devices = [], officers = [], shifts = [], documents = [] }) {
    for (const lane of lanes) state.lanes.set(lane.id, lane);
    for (const device of devices) state.devices.set(device.id, device);
    for (const officer of officers) state.officers.set(officer.id, officer);
    state.shifts.push(...shifts);
    state.documents.push(...documents);
  }

  function assertPublished() {
    if (!state.plan) throw new Error('计划尚未发布');
  }

  function assertRevision(expectedRevision) {
    assertPublished();
    if (expectedRevision !== state.plan.revision) {
      throw new ConflictError(
        `计划已推进到 revision ${state.plan.revision}，拒绝基于 revision ${expectedRevision} 的较晚提交`,
      );
    }
  }

  // 已开始或正在执行的槽位冻结；只有 startMs > now 的槽位可被事件修订。
  function isLocked(slot) {
    return slot.startMs <= now();
  }

  function lockedAssignments() {
    const map = new Map();
    for (const slot of state.plan.slots.filter(isLocked)) {
      for (const post of slot.posts) {
        if (!post.officerId) continue;
        const list = map.get(post.officerId) ?? [];
        list.push({ startMs: slot.startMs, endMs: slot.endMs });
        map.set(post.officerId, list);
      }
    }
    return map;
  }

  // 用当前航班/设备状态重排未执行槽位，冻结槽位原样保留。
  function replanOpenSlots(reason) {
    const plan = state.plan;
    const locked = plan.slots.filter(isLocked);
    const openSlots = plan.slots.filter((s) => !isLocked(s));
    plan.revision += 1;
    if (openSlots.length === 0) {
      plan.adjustments.push({ revision: plan.revision, atMs: now(), reason, revisedSlotCount: 0 });
      return 0;
    }
    const fromMs = openSlots[0].startMs;
    const demand = demandBySlot([...state.flights.values()], plan.slotMs, fromMs, plan.windowMs.toMs);
    const rebuilt = planDuty({
      fromMs,
      toMs: plan.windowMs.toMs,
      slotMs: plan.slotMs,
      reserveCount: plan.reserveCount,
      flights: [...state.flights.values()],
      lanes: [...state.lanes.values()],
      devices: [...state.devices.values()],
      officers: [...state.officers.values()],
      shifts: state.shifts,
      demand,
      priorAssignments: lockedAssignments(),
      postSeqStart: plan.postSeq,
    });
    plan.postSeq += rebuilt.slots.reduce((n, s) => n + s.posts.length, 0);
    plan.slots = [...locked, ...rebuilt.slots];
    plan.adjustments.push({
      revision: plan.revision,
      atMs: now(),
      reason,
      revisedSlotCount: rebuilt.slots.length,
    });
    plan.handoverLog.push({
      revision: plan.revision,
      atMs: now(),
      lockedSlots: locked.map((s) => ({
        startMs: s.startMs,
        assignments: s.posts.filter((p) => p.officerId).map((p) => ({ postId: p.id, officerId: p.officerId })),
      })),
    });
    return rebuilt.slots.length;
  }

  // ---- 计划发布 ----
  function publishPlan({ fromMs, toMs, flights }) {
    if (state.plan) throw new ConflictError('计划已发布，请用事件修订');
    const initial = flights.map(makeFlight);
    for (const flight of initial) {
      state.flights.set(flight.id, flight);
      // 发布即登记幂等键：之后重发同版本航班更新返回首次结果，不再触发重排。
      state.flightResults.set(`${flight.id}@${flight.version}`, { applied: true, revision: 1 });
    }
    const demand = demandBySlot(initial, slotMs, fromMs, toMs);
    const planned = planDuty({
      fromMs,
      toMs,
      slotMs,
      reserveCount,
      flights: initial,
      lanes: [...state.lanes.values()],
      devices: [...state.devices.values()],
      officers: [...state.officers.values()],
      shifts: state.shifts,
      demand,
    });
    state.plan = {
      revision: 1,
      windowMs: { fromMs, toMs },
      slotMs,
      reserveCount,
      slots: planned.slots,
      peakPax: planned.peakPax,
      postSeq: planned.slots.reduce((n, s) => n + s.posts.length, 0),
      adjustments: [],
      handoverLog: [],
    };
    return snapshotPlan();
  }

  // ---- 事件：航班改时/改量 ----
  // 幂等：同一 (id, version) 重复提交返回首次结果（先于版本冲突检查，
  // 因为重试可能带着旧 revision）；未见过且不更新的版本拒绝。
  function applyFlightUpdate(input, { expectedRevision } = {}) {
    assertPublished();
    const flight = makeFlight(input);
    const key = `${flight.id}@${flight.version}`;
    if (state.flightResults.has(key)) {
      return { ...state.flightResults.get(key), duplicate: true };
    }
    assertRevision(expectedRevision);
    const current = state.flights.get(flight.id);
    if (current && flight.version <= current.version) {
      throw new StaleVersionError(`航班 ${flight.id} 版本 ${flight.version} 不新于当前版本 ${current.version}`);
    }
    state.flights.set(flight.id, flight);
    const revisedSlotCount = replanOpenSlots(
      `航班 ${flight.id} 更新到版本 ${flight.version}（${flight.direction}，有效客流 ${effectivePax(flight)}）`,
    );
    const result = { applied: true, revision: state.plan.revision, revisedSlotCount };
    state.flightResults.set(key, result);
    return { ...result, duplicate: false };
  }

  // ---- 事件：设备停用/恢复 ----
  function setDeviceActive(deviceId, active, { expectedRevision } = {}) {
    assertRevision(expectedRevision);
    const device = state.devices.get(deviceId);
    if (!device) throw new Error(`设备 ${deviceId} 不存在`);
    if (device.active === active) return { applied: false, revision: state.plan.revision };
    state.devices.set(deviceId, { ...device, active });
    const affected = [...state.lanes.values()].filter((l) => l.deviceIds.includes(deviceId));
    const revisedSlotCount = replanOpenSlots(
      `设备 ${deviceId} ${active ? '恢复' : '停用'}，影响通道 ${affected.map((l) => l.id).join(',') || '无'}`,
    );
    return { applied: true, revision: state.plan.revision, revisedSlotCount };
  }

  // ---- 事件：临时增开通道 ----
  function openLane(lane, { expectedRevision } = {}) {
    assertRevision(expectedRevision);
    if (state.lanes.has(lane.id)) throw new ConflictError(`通道 ${lane.id} 已存在`);
    state.lanes.set(lane.id, lane);
    const revisedSlotCount = replanOpenSlots(`临时增开通道 ${lane.id}`);
    return { applied: true, revision: state.plan.revision, revisedSlotCount };
  }

  // ---- 事件：岗位换班 ----
  // 只换未执行槽位；新人员必须具备岗位资质、班次覆盖且不超连续执勤上限。
  function swapPost(postId, newOfficerId, { expectedRevision } = {}) {
    assertRevision(expectedRevision);
    const plan = state.plan;
    for (const slot of plan.slots) {
      const post = slot.posts.find((p) => p.id === postId);
      if (!post) continue;
      if (isLocked(slot)) throw new ConflictError(`岗位 ${postId} 已开始执行，保留原安排`);
      const officer = state.officers.get(newOfficerId);
      if (!officer) throw new Error(`人员 ${newOfficerId} 不存在`);
      if (!officer.qualifications.includes(post.requiredQual)) {
        throw new ConflictError(`人员 ${newOfficerId} 不具备岗位所需资质 ${post.requiredQual}`);
      }
      const shift = state.shifts.find(
        (s) => s.officerId === newOfficerId && s.startMs <= slot.startMs && slot.endMs <= s.endMs,
      );
      if (!shift) throw new ConflictError(`人员 ${newOfficerId} 的班次不覆盖该时段`);
      const assigned = plan.slots.flatMap((s) =>
        s.posts.filter((p) => p.officerId === newOfficerId).map(() => ({ startMs: s.startMs, endMs: s.endMs })),
      );
      if (assigned.some((a) => a.startMs === slot.startMs)) {
        throw new ConflictError(`人员 ${newOfficerId} 在该槽位已有岗位`);
      }
      if (longestContinuousMin([...assigned, { startMs: slot.startMs, endMs: slot.endMs }]) > shift.maxContinuousMin) {
        throw new ConflictError(`人员 ${newOfficerId} 换班后超出连续执勤上限`);
      }
      const previous = post.officerId;
      post.officerId = newOfficerId;
      plan.revision += 1;
      plan.adjustments.push({
        revision: plan.revision,
        atMs: now(),
        reason: `岗位 ${postId} 由 ${previous ?? '空缺'} 换为 ${newOfficerId}`,
        revisedSlotCount: 1,
      });
      return { applied: true, revision: plan.revision };
    }
    throw new Error(`岗位 ${postId} 不存在`);
  }

  // ---- 事件：加急协查 ----
  // 从当前或下一槽位的应急预留岗抽调人员；无人可抽则异常保持未处理。
  function reportAnomaly({ kind, detail, atSlotStartMs }, { expectedRevision } = {}) {
    assertRevision(expectedRevision);
    const plan = state.plan;
    const targetStart = atSlotStartMs ?? slotStartOf(now(), plan.slotMs);
    const anomaly = {
      id: `A${(state.anomalySeq += 1)}`,
      kind,
      detail,
      slotStartMs: targetStart,
      status: 'open',
      assigneeOfficerId: null,
    };
    state.anomalies.push(anomaly);
    const slot = plan.slots.find((s) => s.startMs === targetStart)
      ?? plan.slots.find((s) => s.startMs > targetStart);
    const reserve = slot?.posts.find((p) => p.kind === 'reserve' && p.officerId);
    if (reserve) {
      anomaly.assigneeOfficerId = reserve.officerId;
      anomaly.status = 'assigned';
      reserve.kind = 'assist';
      plan.revision += 1;
      plan.adjustments.push({
        revision: plan.revision,
        atMs: now(),
        reason: `加急协查 ${anomaly.id}（${kind}）抽调 ${reserve.officerId}`,
        revisedSlotCount: 1,
      });
    }
    return { anomaly: { ...anomaly }, revision: plan.revision };
  }

  function resolveAnomaly(anomalyId) {
    const anomaly = state.anomalies.find((a) => a.id === anomalyId);
    if (!anomaly) throw new Error(`异常 ${anomalyId} 不存在`);
    anomaly.status = 'handled';
    return { ...anomaly };
  }

  // ---- 证件材料：只在授权检查范围内可见 ----
  function visibleDocuments(authorizedScopes) {
    const scopes = new Set(authorizedScopes);
    return state.documents.filter((doc) => scopes.has(doc.scope));
  }

  // ---- 交班摘要：同一读取水位 ----
  // now 与 revision 在入口一次性固定，四部分内容取自同一计划快照。
  function handoverSummary() {
    assertPublished();
    const watermark = { atMs: now(), revision: state.plan.revision };
    const plan = state.plan;
    const currentSlot = plan.slots.find((s) => s.startMs <= watermark.atMs && watermark.atMs < s.endMs);
    const openLanes = currentSlot
      ? currentSlot.posts.filter((p) => p.laneId !== null).map((p) => ({
          laneId: p.laneId,
          direction: p.direction,
          officerId: p.officerId,
        }))
      : [];
    const nextGaps = plan.slots
      .filter((s) => s.startMs >= watermark.atMs)
      .filter((s) => s.gapCount > 0 || Object.values(s.unmetPax).some((pax) => pax > 0))
      .map((s) => ({
        startMs: s.startMs,
        unfilledPosts: s.posts.filter((p) => p.officerId === null).map((p) => ({ postId: p.id, kind: p.kind, requiredQual: p.requiredQual })),
        unmetPax: s.unmetPax,
      }));
    return {
      watermark,
      openLanes,
      nextGaps,
      adjustments: plan.adjustments.map((a) => ({ ...a })),
      unhandledAnomalies: state.anomalies.filter((a) => a.status !== 'handled').map((a) => ({ ...a })),
    };
  }

  // 当前时刻之后的客流峰值（用注入时钟界定"之后"）。
  function upcomingPeak() {
    assertPublished();
    const future = state.plan.slots.filter((s) => s.endMs > now());
    if (future.length === 0) return null;
    return future.reduce((peak, s) => {
      const total = (s.demand.entry ?? 0) + (s.demand.exit ?? 0);
      return !peak || total > peak.totalPax ? { slotStartMs: s.startMs, totalPax: total } : peak;
    }, null);
  }

  function snapshotPlan() {
    assertPublished();
    return {
      revision: state.plan.revision,
      windowMs: { ...state.plan.windowMs },
      slotMs: state.plan.slotMs,
      peakPax: state.plan.peakPax,
      slots: state.plan.slots.map((s) => ({
        ...s,
        demand: { ...s.demand },
        unmetPax: { ...s.unmetPax },
        posts: s.posts.map((p) => ({ ...p })),
      })),
      adjustments: state.plan.adjustments.map((a) => ({ ...a })),
      handoverLog: state.plan.handoverLog.map((h) => ({
        ...h,
        lockedSlots: h.lockedSlots.map((s) => ({ ...s, assignments: s.assignments.map((a) => ({ ...a })) })),
      })),
    };
  }

  return {
    registerResources,
    publishPlan,
    applyFlightUpdate,
    setDeviceActive,
    openLane,
    swapPost,
    reportAnomaly,
    resolveAnomaly,
    visibleDocuments,
    handoverSummary,
    upcomingPeak,
    snapshotPlan,
    laneUsable: (laneId) => laneUsable(state.lanes.get(laneId), state.devices),
  };
}
