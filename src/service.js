// 口岸高峰勤务后端（核心，无外部 I/O）。
//
// 职责：
// - 发布值守计划；航班改时、设备停用、岗位换班、加急协查等事件以乐观版本提交，
//   只修订“未执行时段”；已经开始的勤务保留原安排与交接记录；
// - 两个调度员争用同一人员/通道时，基于过期版本（较晚提交）的事件被拒绝；
//   事件携带 eventId 时幂等；航班更新另有 updateId 幂等；
// - 证件材料明细仅通过授权文档库按角色可见；
// - 交班摘要在单一读取水位（nowIso + planVersion + eventSeq）上生成；
// - 全部时间取自可注入时钟，自动化用例可用固定航班与时钟确定性重放。

import { buildSlots, toMinutes } from './time.js';
import { FlightFeed, projectDemand, peakSlot } from './flights.js';
import { planSchedule, CERT } from './scheduler.js';
import { DocumentVault, ROLES } from './documents.js';

export { ROLES, CERT };

export const DEFAULT_CONFIG = {
  slotMinutes: 30,
  arrivalWindowMinutes: 60,
  departureLeadMinutes: 90,
  smartEligibleShare: 0.7,
  smartThroughputPerSlot: 120,
  manualThroughputPerSlot: 45,
  maxContinuousMinutes: 240,
  restMinutes: 30,
};

export class PeakService {
  constructor({ clock, scenario, config = {} }) {
    if (!clock) throw new Error('必须注入时钟');
    this.clock = clock;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.feed = new FlightFeed(scenario.flights ?? []);
    this.lanes = (scenario.lanes ?? []).map((l) => ({ ...l }));
    this.devices = (scenario.devices ?? []).map((d) => ({ ...d }));
    this.officers = (scenario.officers ?? []).map((o) => ({ ...o }));
    this.window = { startIso: scenario.window.startIso, endIso: scenario.window.endIso };
    this.slots = buildSlots(this.window.startIso, this.window.endIso, this.config.slotMinutes);

    this.vault = new DocumentVault();
    for (const doc of scenario.documents ?? []) this.vault.add(doc);

    this.outages = new Map();
    this.shiftOverrides = new Map();
    this.urgentCases = [];
    this.locksBySlot = new Map();
    this.events = [];
    this.summaryRecords = [];
    this.planVersion = 0;
    this.plan = null;
    this._resourceVersions = new Map();
    this._backlog = null;
  }

  now() {
    return this.clock.now();
  }

  // ---- 发布首版计划 ----
  publish() {
    if (this.plan) return { ok: false, reason: 'already-published', planVersion: this.planVersion };
    this.planVersion = 1;
    this._replan({ type: 'publish', atIso: this.now(), eventId: 'publish' });
    return { ok: true, planVersion: this.planVersion, peak: this.plan.peak };
  }

  // ---- 事件提交（统一入口，线性账本 + 乐观并发）----
  submitEvent(event) {
    if (!this.plan) return { ok: false, reason: 'not-published' };
    if (!event || !event.type) return { ok: false, reason: 'bad-event' };

    // 事件级幂等：同一 eventId 永远回放同一结果。
    if (event.eventId) {
      const prior = this.events.find((e) => e.eventId === event.eventId);
      if (prior) return clone(prior.result);
    }

    // 乐观并发：过期计划版本直接拒绝（“较晚版本”）。
    if (event.expectedVersion !== undefined && event.expectedVersion !== this.planVersion) {
      return this._reject(event, 'plan-version-conflict',
        `期望计划版本 ${event.expectedVersion}，当前版本 ${this.planVersion}`);
    }

    // 资源级版本：争用同一人员或通道时拒绝后来者。
    const resources = this._resourceKeys(event);
    const expectedRV = event.resourceVersions ?? {};
    for (const key of resources) {
      const cur = this._resourceVersions.get(key) ?? 0;
      if (expectedRV[key] !== undefined && expectedRV[key] !== cur) {
        return this._reject(event, 'resource-conflict', `资源 ${key} 已被其他调度员修改`);
      }
    }

    const result = this._apply(event);
    const entry = {
      seq: this.events.length + 1,
      eventId: event.eventId ?? null,
      dispatcherId: event.dispatcherId ?? null,
      type: event.type,
      atIso: this.now(),
      baseVersion: this.planVersion,
      payload: sanitizeEvent(event),
      result,
    };
    this.events.push(entry);
    if (result.ok) {
      for (const key of resources) {
        this._resourceVersions.set(key, (this._resourceVersions.get(key) ?? 0) + 1);
      }
    }
    return clone(result);
  }

  resourceVersion(key) {
    return this._resourceVersions.get(key) ?? 0;
  }

  _reject(event, reason, detail) {
    const result = { ok: false, reason, detail };
    this.events.push({
      seq: this.events.length + 1,
      eventId: event.eventId ?? null,
      dispatcherId: event.dispatcherId ?? null,
      type: event.type,
      atIso: this.now(),
      baseVersion: this.planVersion,
      payload: sanitizeEvent(event),
      result,
    });
    return clone(result);
  }

  _resourceKeys(event) {
    switch (event.type) {
      case 'flight-update':
        return [`flight:${event.flightNo}`];
      case 'device-outage':
        return [`device:${event.deviceId}`];
      case 'shift-change':
        return [`officer:${event.officerId}`];
      case 'post-swap':
        return [`lane:${event.laneId}`, `officer:${event.toOfficerId}`];
      case 'urgent-case':
        return [`case:${event.caseId}`];
      case 'doc-anomaly':
        return [`flight:${event.flightNo}`];
      default:
        return [];
    }
  }

  _apply(event) {
    switch (event.type) {
      case 'flight-update':
        return this._applyFlightUpdate(event);
      case 'doc-anomaly':
        return this._applyDocAnomaly(event);
      case 'device-outage':
        return this._applyDeviceOutage(event);
      case 'shift-change':
        return this._applyShiftChange(event);
      case 'post-swap':
        return this._applyPostSwap(event);
      case 'urgent-case':
        return this._applyUrgentCase(event);
      case 'resolve-anomaly':
        return this._applyResolve(event);
      default:
        return { ok: false, reason: 'unknown-event-type' };
    }
  }

  _applyFlightUpdate(event) {
    const r = this.feed.applyUpdate({
      flightNo: event.flightNo,
      updateId: event.updateId ?? event.eventId,
      expectedVersion: event.expectedFlightVersion,
      revisedIso: event.revisedIso,
      estPax: event.estPax,
      actualPax: event.actualPax,
      docAnomalyPax: event.docAnomalyPax,
    });
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.reason === 'stale-version'
      ? `航班 ${event.flightNo} 当前版本 ${r.currentVersion}` : undefined };
    this._bumpAndReplan(event);
    return { ok: true, flightVersion: r.version, planVersion: this.planVersion,
      basis: event.reason ?? '航班信息更新' };
  }

  _applyDocAnomaly(event) {
    const f = this.feed.get(event.flightNo);
    if (!f) return { ok: false, reason: 'unknown-flight' };
    const r = this.feed.applyUpdate({
      flightNo: event.flightNo,
      updateId: event.updateId ?? event.eventId,
      expectedVersion: event.expectedFlightVersion ?? f.version,
      docAnomalyPax: event.docAnomalyPax,
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    if (event.docId) {
      this.vault.add({
        docId: event.docId,
        caseRef: event.caseRef ?? event.docId,
        flightNo: event.flightNo,
        summary: event.summary ?? '',
        materials: event.materials ?? [],
        scope: event.scope,
        createdAt: this.now(),
      });
    }
    this._bumpAndReplan(event);
    return { ok: true, flightVersion: r.version, planVersion: this.planVersion,
      basis: `证件异常 ${event.docAnomalyPax} 人转人工查验` };
  }

  _applyDeviceOutage(event) {
    const device = this.devices.find((d) => d.id === event.deviceId);
    if (!device) return { ok: false, reason: 'unknown-device' };
    const list = this.outages.get(event.deviceId) ?? [];
    list.push({ fromIso: event.fromIso ?? this.now(), toIso: event.toIso ?? null });
    this.outages.set(event.deviceId, list);
    this._bumpAndReplan(event);
    return { ok: true, planVersion: this.planVersion,
      basis: `设备 ${event.deviceId} 停用，未执行时段改排其他通道` };
  }

  _applyShiftChange(event) {
    const off = this.officers.find((o) => o.id === event.officerId);
    if (!off) return { ok: false, reason: 'unknown-officer' };
    if (!event.shift || !event.shift.startIso || !event.shift.endIso) {
      return { ok: false, reason: 'bad-shift' };
    }
    if (toMinutes(event.shift.endIso) <= toMinutes(event.shift.startIso)) {
      return { ok: false, reason: 'bad-shift' };
    }
    // 换班只能影响未执行时段。
    if (toMinutes(event.fromIso) <= toMinutes(this.now())) {
      return { ok: false, reason: 'slot-already-started', detail: '换班生效时间不得早于当前时间' };
    }
    const list = this.shiftOverrides.get(event.officerId) ?? [];
    list.push({ fromIso: event.fromIso, shift: { ...event.shift }, reason: event.reason ?? '岗位换班' });
    list.sort((a, b) => toMinutes(a.fromIso) - toMinutes(b.fromIso));
    this.shiftOverrides.set(event.officerId, list);
    this._bumpAndReplan(event);
    return { ok: true, planVersion: this.planVersion, basis: event.reason ?? `人员 ${event.officerId} 班次调整` };
  }

  _applyPostSwap(event) {
    const lane = this.lanes.find((l) => l.id === event.laneId);
    const to = this.officers.find((o) => o.id === event.toOfficerId);
    if (!lane) return { ok: false, reason: 'unknown-lane' };
    if (!to) return { ok: false, reason: 'unknown-officer' };
    const slotIndex = this.slots.findIndex((s) => s.start === event.slotStart);
    if (slotIndex === -1) return { ok: false, reason: 'unknown-slot' };
    if (toMinutes(event.slotStart) <= toMinutes(this.now())) {
      return { ok: false, reason: 'slot-already-started', detail: '已开始的勤务不能换岗，只能在交接记录中保留' };
    }
    const needCert = lane.mode === 'manual' ? CERT.manual : CERT.smart;
    if (!to.certs.includes(needCert)) {
      return { ok: false, reason: 'officer-not-certified',
        detail: `${to.id} 不具备 ${lane.mode === 'manual' ? '人工查验' : '自助监管'} 资质` };
    }
    if (to.directions && !to.directions.includes(lane.direction)) {
      return { ok: false, reason: 'officer-not-authorized-direction',
        detail: `${to.id} 不具备 ${lane.direction === 'entry' ? '入境' : '出境'} 方向授权` };
    }
    // 接替者的班次（含已确认的换班）必须覆盖目标时段。
    const slot = this.slots[slotIndex];
    const shift = this._effectiveShift(to, slot.start);
    if (toMinutes(shift.startIso) > toMinutes(slot.start) ||
        toMinutes(shift.endIso) < toMinutes(slot.end)) {
      return { ok: false, reason: 'officer-shift-mismatch', detail: `${to.id} 班次不覆盖该时段` };
    }
    if (event.fromOfficerId && !this.officers.some((o) => o.id === event.fromOfficerId)) {
      return { ok: false, reason: 'unknown-officer' };
    }
    // 同通道同时段已锁定给他人、或接替者已锁定到其他通道：拒绝后来的争用。
    const existing = this.locksBySlot.get(slotIndex) ?? [];
    if (existing.some((l) => l.laneId === lane.id && l.officerId !== to.id)) {
      return { ok: false, reason: 'resource-conflict', detail: `通道 ${lane.id} 该时段已有换岗锁定` };
    }
    if (existing.some((l) => l.officerId === to.id && l.laneId !== lane.id)) {
      return { ok: false, reason: 'resource-conflict', detail: `${to.id} 该时段已锁定到其他通道` };
    }
    if (existing.some((l) => l.laneId === lane.id && l.officerId === to.id)) {
      return { ok: true, planVersion: this.planVersion, basis: '相同换岗锁定已存在，保持原结果' };
    }
    // 记录岗位锁定，重排时接替者固定在该通道该时段。
    const list = this.locksBySlot.get(slotIndex) ?? [];
    list.push({ laneId: lane.id, officerId: to.id, eventId: event.eventId ?? null });
    this.locksBySlot.set(slotIndex, list);
    // 交接记录在重排中保留：即使计划再修订，原换岗交接始终可追溯。
    this._bumpAndReplan(event, {
      handover: {
        slotIndex, laneId: lane.id,
        fromOfficerId: event.fromOfficerId ?? null,
        toOfficerId: event.toOfficerId,
        reason: event.reason ?? '岗位换班',
        atIso: this.now(),
        eventId: event.eventId ?? null,
      },
    });
    return { ok: true, planVersion: this.planVersion, basis: event.reason ?? `通道 ${lane.id} 换岗` };
  }

  _applyUrgentCase(event) {
    if (!event.caseId || !event.startIso || !event.endIso) return { ok: false, reason: 'bad-case' };
    if (toMinutes(event.endIso) <= toMinutes(event.startIso)) return { ok: false, reason: 'bad-case' };
    if (toMinutes(event.startIso) <= toMinutes(this.now())) {
      return { ok: false, reason: 'slot-already-started', detail: '加急协查只能安排在未执行时段' };
    }
    if (this.urgentCases.some((c) => c.caseId === event.caseId)) {
      return { ok: false, reason: 'duplicate-case' };
    }
    if (event.direction && !['entry', 'exit'].includes(event.direction)) {
      return { ok: false, reason: 'bad-direction' };
    }
    const caze = {
      caseId: event.caseId,
      startIso: event.startIso,
      endIso: event.endIso,
      staffCount: event.staffCount ?? 1,
      direction: event.direction ?? null,
    };
    this.urgentCases.push(caze);
    if (event.docId) {
      this.vault.add({
        docId: event.docId,
        caseRef: event.caseId,
        flightNo: event.flightNo ?? null,
        summary: event.summary ?? '',
        materials: event.materials ?? [],
        scope: event.scope,
        createdAt: this.now(),
      });
    }
    this._bumpAndReplan(event);
    return { ok: true, planVersion: this.planVersion,
      basis: `加急协查 ${event.caseId} 优先动用应急预留 ${caze.staffCount} 人` };
  }

  _applyResolve(event) {
    const doc = this.vault.docs.get(event.docId);
    if (!doc) return { ok: false, reason: 'unknown-doc' };
    this.vault.markHandled(event.docId);
    if (event.removeCaseId) {
      this.urgentCases = this.urgentCases.filter((c) => c.caseId !== event.removeCaseId);
      this._bumpAndReplan(event);
    }
    return { ok: true, planVersion: this.planVersion, basis: `异常 ${event.docId} 已处理` };
  }

  _bumpAndReplan(event, extra = {}) {
    this.planVersion += 1;
    this._replan(event, extra);
  }

  _effectiveShift(officer, atIso) {
    const list = (this.shiftOverrides.get(officer.id) ?? [])
      .filter((o) => toMinutes(o.fromIso) <= toMinutes(atIso))
      .sort((a, b) => toMinutes(a.fromIso) - toMinutes(b.fromIso));
    return list.length ? list[list.length - 1].shift : officer.shift;
  }

  // ---- 重排：冻结已开始时段，只求解未执行时段 ----
  _replan(event, extra = {}) {
    const nowIso = this.now();
    const demand = projectDemand(this.feed, this.slots, this.config);

    const frozenLaneAssign = new Map();
    const frozenUrgentAssign = new Map();
    const frozenReserves = new Map();
    const frozenGaps = [];
    if (this.plan) {
      for (const a of this.plan.schedule.assignments) {
        if (a.frozen || toMinutes(this.slots[a.slotIndex].start) <= toMinutes(nowIso)) {
          const list = frozenLaneAssign.get(a.slotIndex) ?? [];
          list.push({ laneId: a.laneId, officerId: a.officerId });
          frozenLaneAssign.set(a.slotIndex, list);
        }
      }
      for (const u of this.plan.schedule.urgentAssign) {
        if (u.frozen || toMinutes(this.slots[u.slotIndex].start) <= toMinutes(nowIso)) {
          const list = frozenUrgentAssign.get(u.slotIndex) ?? [];
          list.push({ caseId: u.caseId, officerIds: u.officerIds });
          frozenUrgentAssign.set(u.slotIndex, list);
        }
      }
      for (const r of this.plan.schedule.reserves) {
        if (r.frozen || toMinutes(this.slots[r.slotIndex].start) <= toMinutes(nowIso)) {
          frozenReserves.set(r.slotIndex, r.officerIds);
        }
      }
      for (const g of this.plan.schedule.gaps) {
        if (toMinutes(this.slots[g.slotIndex].start) <= toMinutes(nowIso)) frozenGaps.push({ ...g });
      }
    }

    // 只把未执行时段的岗位锁定传给编排器。
    const locksBySlot = new Map();
    for (const [idx, list] of this.locksBySlot) {
      if (toMinutes(this.slots[idx].start) > toMinutes(nowIso)) locksBySlot.set(idx, list);
    }

    const schedule = planSchedule({
      slots: this.slots,
      demand,
      lanes: this.lanes,
      devices: this.devices,
      officers: this.officers,
      outages: this.outages,
      shiftOverrides: this.shiftOverrides,
      urgentCases: this.urgentCases,
      frozenLaneAssign,
      frozenUrgentAssign,
      frozenReserves,
      frozenGaps,
      assignmentLocks: locksBySlot,
      nowIso,
      config: this.config,
    });

    const peak = peakSlot(this.slots, demand);
    const backlog = this._computeBacklog(schedule);
    const handovers = this.plan ? [...this.plan.handovers] : [];
    if (extra.handover) handovers.push({ ...extra.handover, planVersion: this.planVersion });

    this.plan = {
      publishedAt: this.plan ? this.plan.publishedAt : nowIso,
      revisedAt: nowIso,
      planVersion: this.planVersion,
      causedBy: event ? (event.eventId ?? event.type) : null,
      slots: this.slots,
      demand,
      schedule,
      peak,
      backlog,
      handovers,
    };
    this._backlog = backlog;
  }

  // 逐方向、逐时段队列：自助饱和旅客转人工；只有人工通道也消化不了的人数才排队并结转。
  _computeBacklog(schedule) {
    const carry = { entry: 0, exit: 0 };
    return schedule.openBySlot.map(({ slotIndex, lanes }) => {
      const d = schedule.demand[slotIndex];
      const out = { slotIndex, directions: {} };
      for (const dir of ['entry', 'exit']) {
        const smartCap = lanes.filter((l) => l.mode === 'smart' && l.direction === dir).length *
          this.config.smartThroughputPerSlot;
        const manualCap = lanes.filter((l) => l.mode === 'manual' && l.direction === dir).length *
          this.config.manualThroughputPerSlot;
        const divertedToManual = Math.max(0, d[dir].smartPax - smartCap);
        const manualIn = d[dir].manualPax + divertedToManual + carry[dir];
        const queued = Math.max(0, manualIn - manualCap);
        carry[dir] = queued;
        out.directions[dir] = {
          divertedToManual,
          manualQueue: queued,
          totalQueue: queued,
        };
      }
      out.totalQueue = out.directions.entry.totalQueue + out.directions.exit.totalQueue;
      return out;
    });
  }

  // ---- 交班值守摘要：同一读取水位 ----
  handoverSummary({ viewerRoles = [ROLES.commander], dispatcherId = null } = {}) {
    if (!this.plan) throw new Error('计划尚未发布');
    const nowIso = this.now();
    const watermark = { nowIso, planVersion: this.planVersion, eventSeq: this.events.length };

    const currentIndex = this.slots.findIndex(
      (s) => toMinutes(nowIso) >= toMinutes(s.start) && toMinutes(nowIso) < toMinutes(s.end),
    );
    const futureIndex = this.slots.findIndex((s) => toMinutes(s.start) > toMinutes(nowIso));

    const openLanes = currentIndex === -1 ? []
      : this.plan.schedule.openBySlot[currentIndex].lanes.map((l) => ({
        laneId: l.laneId, mode: l.mode, direction: l.direction, officerId: l.officerId,
      }));

    const openCases = currentIndex === -1 ? []
      : this.plan.schedule.urgentAssign
        .filter((u) => u.slotIndex === currentIndex)
        .map((u) => ({ caseId: u.caseId, officerIds: u.officerIds }));

    // 下一时段缺口：通道/设备/警力/预留缺口 + 队列结转。
    const nextGaps = futureIndex === -1 ? []
      : this.plan.schedule.gaps.filter((g) => g.slotIndex === futureIndex).map((g) => ({ ...g }));
    const nextBacklog = futureIndex === -1 ? null : this.plan.backlog[futureIndex];
    const nextReserves = futureIndex === -1 ? []
      : (this.plan.schedule.reserves.find((r) => r.slotIndex === futureIndex)?.officerIds ?? []);

    // 临时调整依据：自上次交班摘要以来被接受的事件（账本顺序即时间顺序）。
    const sinceSeq = this.summaryRecords.length
      ? this.summaryRecords[this.summaryRecords.length - 1].eventSeq
      : 0;
    const adjustments = this.events
      .filter((e) => e.result.ok && e.seq > sinceSeq)
      .map((e) => ({ seq: e.seq, type: e.type, atIso: e.atIso, basis: e.result.basis ?? null,
        dispatcherId: e.dispatcherId ?? null }));

    // 未处理异常：授权材料按角色裁剪；未授权只能看到编号而看不到内容。
    const anomalyDocs = this.vault.list(viewerRoles).filter((d) => !d.handled);

    // 协查案件在结束前（或显式撤销前）始终属于未处理异常，并标注当前派警是否足额。
    const urgentByCaseSlot = new Map();
    for (const u of this.plan.schedule.urgentAssign) {
      urgentByCaseSlot.set(`${u.caseId}@${u.slotIndex}`, u.officerIds.length);
    }
    const pendingCases = this.urgentCases
      .filter((c) => toMinutes(c.endIso) > toMinutes(nowIso))
      .map((c) => {
        const understaffedSlots = this.slots.filter((s, idx) =>
          toMinutes(s.start) >= toMinutes(nowIso) &&
          toMinutes(s.start) >= toMinutes(c.startIso) &&
          toMinutes(s.end) <= toMinutes(c.endIso) &&
          (urgentByCaseSlot.get(`${c.caseId}@${idx}`) ?? 0) < c.staffCount).length;
        return { caseId: c.caseId, startIso: c.startIso, endIso: c.endIso,
          staffCount: c.staffCount, direction: c.direction,
          status: understaffedSlots > 0 ? 'understaffed' : 'staffed' };
      });

    const summary = {
      watermark,
      currentSlot: currentIndex === -1 ? null : this.slots[currentIndex],
      openLanes,
      openCases,
      nextSlot: futureIndex === -1 ? null : this.slots[futureIndex],
      nextSlotGaps: nextGaps,
      nextSlotQueue: nextBacklog,
      nextSlotReserves: nextReserves,
      adjustments,
      unhandledAnomalies: { docs: anomalyDocs, cases: pendingCases },
      handoverRecords: this.plan.handovers,
      peak: this.plan.peak,
    };

    const record = {
      atIso: nowIso,
      by: dispatcherId,
      eventSeq: this.events.length,
      planVersion: this.planVersion,
      summary,
    };
    this.summaryRecords.push(record);
    return summary;
  }

  // 仅供测试/重放观察：当前计划快照（深拷贝，防止外部改写）。
  snapshot() {
    return clone({
      planVersion: this.planVersion,
      now: this.now(),
      plan: this.plan,
      events: this.events.map(({ result, ...e }) => ({ ...e, accepted: result.ok })),
    });
  }
}

function sanitizeEvent(event) {
  const { materials, summary, ...rest } = event;
  // 证件材料明细不进事件账本，只存在于授权文档库。
  return { ...rest, hasMaterials: (materials?.length ?? 0) > 0 };
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
