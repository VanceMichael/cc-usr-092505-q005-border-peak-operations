// 排班规划器：把客流需求翻译成"槽位 × 岗位"，再在资质、班次窗口、
// 连续执勤上限约束下把人员确定性地填入岗位，缺口与应急预留一并输出。
// 纯函数：同一份输入永远得到同一份计划，便于固定时钟重放。

import { longestContinuousMin } from './model.js';

function postsForSlot(slotStartMs, slotEndMs, demand, lanes, devicesById) {
  const posts = [];
  const remaining = new Map([
    ['entry', demand.get('entry') ?? 0],
    ['exit', demand.get('exit') ?? 0],
  ]);

  // 按容量从大到小、智能通道优先地开通道；哪个方向剩余客流多就先服务哪个方向。
  const candidates = lanes
    .filter((lane) => laneUsableSafe(lane, devicesById))
    .sort((a, b) => b.capacityPerSlot - a.capacityPerSlot || a.id.localeCompare(b.id));

  const usedLaneIds = new Set();
  for (const lane of candidates) {
    if ([...remaining.values()].every((pax) => pax <= 0)) break;
    const direction = [...remaining.entries()]
      .filter(([dir]) => lane.directions.includes(dir))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    // 该通道能服务的方向都已满足时，不为了开通道而开通道。
    if (!direction || remaining.get(direction) <= 0) continue;
    posts.push({
      laneId: lane.id,
      kind: lane.kind,
      direction,
      requiredQual: lane.kind === 'smart' ? 'smart' : 'manual',
    });
    usedLaneIds.add(lane.id);
    remaining.set(direction, remaining.get(direction) - lane.capacityPerSlot);
  }

  const openCount = posts.length;
  if (openCount > 0) {
    posts.push({ laneId: null, kind: 'lead', direction: null, requiredQual: 'lead' });
  }
  const unmetPax = Object.fromEntries([...remaining.entries()].map(([dir, pax]) => [dir, Math.max(0, pax)]));
  return { posts, unmetPax };
}

function laneUsableSafe(lane, devicesById) {
  if (lane.kind !== 'smart') return true;
  return lane.deviceIds.every((id) => devicesById.get(id)?.active === true);
}

// 为一个岗位选择可上岗人员。
function pickOfficer(post, slotStartMs, slotEndMs, officersById, shiftsByOfficer, usedThisSlot, assignedByOfficer) {
  for (const officer of [...officersById.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!officer.qualifications.includes(post.requiredQual)) continue;
    if (usedThisSlot.has(officer.id)) continue;
    const shift = shiftsByOfficer.get(officer.id)?.find(
      (s) => s.startMs <= slotStartMs && slotEndMs <= s.endMs,
    );
    if (!shift) continue;
    const trial = [...(assignedByOfficer.get(officer.id) ?? []), { startMs: slotStartMs, endMs: slotEndMs }];
    if (longestContinuousMin(trial) > shift.maxContinuousMin) continue;
    return { officer, shift };
  }
  return null;
}

// 生成一份完整值守计划。
// input:
//   windowMs {fromMs,toMs}, slotMs, reserveCount
//   flights, lanes, devices, officers, shifts, demand（Map<slot,Map<dir,pax>>）
export function planDuty(input) {
  const { slotMs, reserveCount, flights, lanes, devices, officers, shifts, demand } = input;
  const devicesById = new Map(devices.map((d) => [d.id, d]));
  const officersById = new Map(officers.map((o) => [o.id, o]));
  const shiftsByOfficer = new Map();
  for (const shift of shifts) {
    const list = shiftsByOfficer.get(shift.officerId) ?? [];
    list.push(shift);
    shiftsByOfficer.set(shift.officerId, list);
  }

  const slots = [...demand.keys()].sort((a, b) => a - b);
  // 修订重排时，已开始/已执行槽位保持原安排，但其占用计入连续执勤上下文。
  const assignedByOfficer = new Map();
  for (const [officerId, list] of input.priorAssignments ?? []) {
    assignedByOfficer.set(officerId, list.map((s) => ({ ...s })));
  }
  const plannedSlots = [];
  // 岗位序号由调用方跨重排推进，保证全计划内岗位 id 唯一。
  let postSeq = input.postSeqStart ?? 0;

  for (const slotStartMs of slots) {
    const slotEndMs = slotStartMs + slotMs;
    const dirDemand = demand.get(slotStartMs) ?? new Map();
    const { posts, unmetPax } = postsForSlot(slotStartMs, slotEndMs, dirDemand, lanes, devicesById);
    for (let i = 0; i < reserveCount; i += 1) {
      posts.push({ laneId: null, kind: 'reserve', direction: null, requiredQual: 'assist' });
    }

    const usedThisSlot = new Set();
    const plannedPosts = [];
    // 查验岗优先于带班、应急预留，保证高峰时资质警力先压到通道。
    posts.sort((a, b) => postPriority(a) - postPriority(b) || a.kind.localeCompare(b.kind));
    for (const post of posts) {
      const choice = pickOfficer(
        post, slotStartMs, slotEndMs, officersById, shiftsByOfficer, usedThisSlot, assignedByOfficer,
      );
      const planned = {
        id: `P${(postSeq += 1)}`,
        slotStartMs,
        slotEndMs,
        ...post,
        officerId: choice?.officer.id ?? null,
      };
      if (choice) {
        usedThisSlot.add(choice.officer.id);
        const list = assignedByOfficer.get(choice.officer.id) ?? [];
        list.push({ startMs: slotStartMs, endMs: slotEndMs });
        assignedByOfficer.set(choice.officer.id, list);
      }
      plannedPosts.push(planned);
    }

    const gapCount = plannedPosts.filter((p) => p.officerId === null).length;
    plannedSlots.push({
      startMs: slotStartMs,
      endMs: slotEndMs,
      demand: Object.fromEntries(dirDemand),
      unmetPax,
      openLaneIds: plannedPosts.filter((p) => p.laneId !== null).map((p) => p.laneId),
      posts: plannedPosts,
      gapCount,
    });
  }

  return {
    windowMs: { fromMs: input.fromMs, toMs: input.toMs },
    slotMs,
    reserveCount,
    basisFlightIds: flights.map((f) => f.id),
    slots: plannedSlots,
    peakPax: Math.max(0, ...plannedSlots.map((s) => (s.demand.entry ?? 0) + (s.demand.exit ?? 0))),
  };
}

function postPriority(post) {
  if (post.laneId !== null) return 0;
  if (post.kind === 'lead') return 1;
  return 2;
}
