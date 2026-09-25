// 勤务编排器：把客流需求、通道/设备能力、人员资质与班次休息约束、
// 应急预留统一排进时段计划。
//
// 确定性原则：所有候选按 id 排序，贪心分配；同一输入永远得到同一计划。
// 冻结原则：start <= nowIso 的时段连同既有安排原样保留（含历史缺口与预留），
//           只重排未执行时段；连续执勤/休息状态从冻结时段逐段推进后再求解。

import { toMinutes } from './time.js';

export const CERT = {
  manual: 'manual-inspection',
  smart: 'smart-supervision',
  urgent: 'urgent-cooperation',
};

function effectiveShift(officer, overrides, slotStart) {
  const list = (overrides.get(officer.id) ?? []).filter(
    (o) => toMinutes(o.fromIso) <= toMinutes(slotStart),
  );
  return list.length === 0 ? officer.shift : list[list.length - 1].shift;
}

function covers(shift, slot) {
  return toMinutes(shift.startIso) <= toMinutes(slot.start) &&
    toMinutes(shift.endIso) >= toMinutes(slot.end);
}

function supportsDirection(off, direction) {
  return !off.directions || !direction || off.directions.includes(direction);
}

// 设备在某时段是否可用（停用区间按时段起点判定）。
export function deviceActiveAt(device, outages, slot) {
  if (!device || device.status !== 'active') return false;
  const t = toMinutes(slot.start);
  for (const r of outages.get(device.id) ?? []) {
    if (t >= toMinutes(r.fromIso) && (r.toIso === null || t < toMinutes(r.toIso))) {
      return false;
    }
  }
  return true;
}

const ceilDiv = (a, b) => Math.ceil(a / b);

export function planSchedule(input) {
  const {
    slots, demand, lanes, devices, outages = new Map(),
    shiftOverrides = new Map(), urgentCases = [],
    frozenLaneAssign = new Map(), frozenUrgentAssign = new Map(),
    frozenReserves = new Map(), frozenGaps = [],
    assignmentLocks = new Map(),
    nowIso, config,
  } = input;

  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const officers = input.officers.map((o) => ({
    ...o,
    runSlots: 0,      // 当前连续执勤时段数
    restDueSlots: 0,  // 剩余强制休息时段数
  }));
  const byId = new Map(officers.map((o) => [o.id, o]));

  const frozenUntil = slots.findIndex((s) => toMinutes(s.start) > toMinutes(nowIso));
  const frozenCount = frozenUntil === -1 ? slots.length : frozenUntil;

  const assignments = [];
  const urgentAssign = [];
  const reserves = [];
  const gaps = [...frozenGaps];
  const openBySlot = [];

  const markWork = (off) => {
    off.runSlots += 1;
    if (off.runSlots * config.slotMinutes >= config.maxContinuousMinutes) {
      off.restDueSlots = Math.max(1, Math.ceil(config.restMinutes / config.slotMinutes));
    }
  };
  const tickRoster = (off, worked) => {
    if (worked) {
      markWork(off);
    } else if (off.restDueSlots > 0) {
      off.restDueSlots -= 1;
      if (off.restDueSlots === 0) off.runSlots = 0;
    } else {
      off.runSlots = 0; // 空闲即中断连续执勤
    }
  };
  const isAvailable = (off, slot) =>
    off.restDueSlots === 0 && covers(effectiveShift(off, shiftOverrides, slot.start), slot);

  const matchOfficer = (used, cert, direction, slot, { reserve = false } = {}) =>
    officers
      .filter((o) => o.reserve === reserve)
      .filter((o) => !used.has(o.id))
      .filter((o) => o.certs.includes(cert))
      .filter((o) => supportsDirection(o, direction))
      .filter((o) => isAvailable(o, slot))
      .sort((a, b) => a.runSlots - b.runSlots || a.id.localeCompare(b.id))[0] ?? null;

  const laneBundle = (dir) => {
    const of = lanes.filter((l) => l.direction === dir).sort((a, b) => a.id.localeCompare(b.id));
    return { manual: of.filter((l) => l.mode === 'manual'), smart: of.filter((l) => l.mode === 'smart') };
  };

  slots.forEach((slot, i) => {
    const frozen = i < frozenCount;
    const used = new Set();
    const openLanes = [];

    const activeCases = urgentCases
      .filter((c) => toMinutes(slot.start) >= toMinutes(c.startIso) &&
                     toMinutes(slot.end) <= toMinutes(c.endIso))
      .sort((a, b) => a.caseId.localeCompare(b.caseId));

    if (frozen) {
      // ---- 已开始时段：原安排、交接记录一律保留 ----
      for (const u of frozenUrgentAssign.get(i) ?? []) {
        urgentAssign.push({ slotIndex: i, caseId: u.caseId, officerIds: [...u.officerIds], frozen: true });
        for (const id of u.officerIds) {
          used.add(id);
          const off = byId.get(id);
          if (off) tickRoster(off, true);
        }
      }
      for (const a of frozenLaneAssign.get(i) ?? []) {
        assignments.push({ slotIndex: i, laneId: a.laneId, officerId: a.officerId, frozen: true });
        used.add(a.officerId);
        const off = byId.get(a.officerId);
        if (off) tickRoster(off, true);
        const lane = lanes.find((l) => l.id === a.laneId);
        openLanes.push({ laneId: a.laneId, mode: lane?.mode, direction: lane?.direction, officerId: a.officerId });
      }
      reserves.push({ slotIndex: i, officerIds: [...(frozenReserves.get(i) ?? [])], frozen: true });
      openBySlot.push({ slotIndex: i, lanes: openLanes, frozen: true });
      for (const off of officers) {
        if (!used.has(off.id)) tickRoster(off, false);
      }
      return;
    }

    // ---- 加急协查岗：优先动用应急预留警力 ----
    for (const c of activeCases) {
      const picked = [];
      const tryPool = (reserve) => {
        while (picked.length < c.staffCount) {
          const off = matchOfficer(used, CERT.urgent, c.direction ?? null, slot, { reserve });
          if (!off) break;
          picked.push(off.id);
          used.add(off.id);
          tickRoster(off, true);
        }
      };
      tryPool(true);
      tryPool(false);
      urgentAssign.push({ slotIndex: i, caseId: c.caseId, officerIds: picked, frozen: false });
      if (picked.length < c.staffCount) {
        gaps.push({
          slotIndex: i, kind: 'reserve', direction: c.direction ?? 'any', caseId: c.caseId,
          required: c.staffCount, assigned: picked.length,
          detail: `加急协查 ${c.caseId} 缺员 ${c.staffCount - picked.length} 人`,
        });
      }
    }

    // ---- 通道开放与警力编排 ----
    for (const dir of ['entry', 'exit']) {
      const q = demand[i][dir];
      const bundle = laneBundle(dir);

      // 换班事件确认的岗位锁定只在“本来就需要开放”的通道上生效；
      // 接替者资质/休息/在岗不满足，或自助设备停用，记为明确缺口而非静默忽略。
      const locksForDir = (assignmentLocks.get(i) ?? [])
        .map((lock) => ({ lock, lane: lanes.find((l) => l.id === lock.laneId) }))
        .filter((x) => x.lane && x.lane.direction === dir);
      const lockedLaneIds = new Set();
      let smartOpen = 0;
      let manualOpen = 0;
      const placeLock = (lock, lane) => {
        const off = byId.get(lock.officerId);
        const cert = lane.mode === 'manual' ? CERT.manual : CERT.smart;
        if (lane.mode === 'smart' &&
            !deviceActiveAt(deviceById.get(lane.deviceId), outages, slot)) {
          gaps.push({ slotIndex: i, kind: 'device', direction: dir, mode: 'smart', laneId: lane.id,
            detail: `换岗通道 ${lane.id} 设备停用，锁定无法落实` });
          return false;
        }
        if (!off || used.has(off.id) || !off.certs.includes(cert) ||
            !supportsDirection(off, dir) || !isAvailable(off, slot)) {
          gaps.push({ slotIndex: i, kind: 'staff', direction: dir, mode: lane.mode, laneId: lane.id,
            swapped: true, detail: `换岗锁定 ${lock.officerId} 不满足资质/休息/在岗要求` });
          return false;
        }
        used.add(off.id);
        tickRoster(off, true);
        lockedLaneIds.add(lane.id);
        if (lane.mode === 'smart') smartOpen += 1;
        else manualOpen += 1;
        assignments.push({ slotIndex: i, laneId: lane.id, officerId: off.id, frozen: false, swapped: true });
        openLanes.push({ laneId: lane.id, mode: lane.mode, direction: dir, officerId: off.id });
        return true;
      };

      const smartWantedRaw = q.smartPax > 0 ? ceilDiv(q.smartPax, config.smartThroughputPerSlot) : 0;
      for (const { lock, lane } of locksForDir.filter((x) => x.lane.mode === 'smart')
        .slice(0, smartWantedRaw)) {
        placeLock(lock, lane);
      }

      const smartOperational = bundle.smart.filter(
        (l) => !lockedLaneIds.has(l.id) &&
               deviceActiveAt(deviceById.get(l.deviceId), outages, slot),
      );

      const smartWanted = smartWantedRaw;
      if (smartWanted > smartOperational.length + smartOpen) {
        gaps.push({
          slotIndex: i, kind: 'device', direction: dir,
          required: smartWanted, operational: smartOperational.length + smartOpen,
          detail: `${dir === 'entry' ? '入境' : '出境'}自助设备可用数不足，部分旅客转人工`,
        });
      }

      for (const lane of smartOperational.slice(0, Math.max(0, smartWanted - smartOpen))) {
        const off = matchOfficer(used, CERT.smart, dir, slot);
        if (!off) {
          gaps.push({ slotIndex: i, kind: 'staff', direction: dir, mode: 'smart', laneId: lane.id,
            detail: `自助通道 ${lane.id} 无可用监管警力` });
          continue;
        }
        used.add(off.id);
        tickRoster(off, true);
        smartOpen += 1;
        assignments.push({ slotIndex: i, laneId: lane.id, officerId: off.id, frozen: false });
        openLanes.push({ laneId: lane.id, mode: 'smart', direction: dir, officerId: off.id });
      }

      // 自助消化不了的旅客（设备不足或缺警）全部压向人工。
      const smartOverflow = Math.max(0, q.smartPax - smartOpen * config.smartThroughputPerSlot);
      const manualPax = q.manualPax + smartOverflow;
      const manualWanted = manualPax > 0 ? ceilDiv(manualPax, config.manualThroughputPerSlot) : 0;
      for (const { lock, lane } of locksForDir.filter((x) => x.lane.mode === 'manual')
        .slice(0, manualWanted)) {
        if (!lockedLaneIds.has(lane.id)) placeLock(lock, lane);
      }
      const manualCandidates = bundle.manual.filter((l) => !lockedLaneIds.has(l.id));
      if (manualWanted > bundle.manual.length) {
        gaps.push({
          slotIndex: i, kind: 'lane', direction: dir,
          required: manualWanted, available: bundle.manual.length,
          unmetPax: Math.max(0, manualPax - bundle.manual.length * config.manualThroughputPerSlot),
          detail: `${dir === 'entry' ? '入境' : '出境'}人工通道数量不足`,
        });
      }

      const failedManual = [];
      for (const lane of manualCandidates.slice(0, Math.max(0, manualWanted - manualOpen))) {
        const off = matchOfficer(used, CERT.manual, dir, slot);
        if (!off) {
          failedManual.push(lane.id);
          continue;
        }
        used.add(off.id);
        tickRoster(off, true);
        manualOpen += 1;
        assignments.push({ slotIndex: i, laneId: lane.id, officerId: off.id, frozen: false });
        openLanes.push({ laneId: lane.id, mode: 'manual', direction: dir, officerId: off.id });
      }
      for (const laneId of failedManual) {
        gaps.push({ slotIndex: i, kind: 'staff', direction: dir, mode: 'manual', laneId,
          detail: `人工通道 ${laneId} 无具资质且符合休息约束的警力` });
      }
    }

    // 在岗但未上岗的预备警力记为应急预留。
    const reserveIds = officers
      .filter((o) => o.reserve && !used.has(o.id) && isAvailable(o, slot))
      .map((o) => o.id)
      .sort((a, b) => a.localeCompare(b));
    reserves.push({ slotIndex: i, officerIds: reserveIds, frozen: false });

    for (const off of officers) {
      if (!used.has(off.id)) tickRoster(off, false);
    }
    openBySlot.push({ slotIndex: i, lanes: openLanes, frozen: false });
  });

  return {
    slots,
    demand,
    assignments: assignments.sort((a, b) =>
      a.slotIndex - b.slotIndex || a.laneId.localeCompare(b.laneId)),
    urgentAssign: urgentAssign.sort((a, b) =>
      a.slotIndex - b.slotIndex || a.caseId.localeCompare(b.caseId)),
    reserves,
    gaps: gaps.sort((a, b) =>
      a.slotIndex - b.slotIndex || a.kind.localeCompare(b.kind) ||
      (a.laneId ?? '').localeCompare(b.laneId ?? '')),
    openBySlot,
    frozenCount,
  };
}
