// 领域模型：航班、通道、设备、人员、班次的结构校验，以及客流需求与峰值计算。
// 纯函数，不持有状态；时刻一律为 epoch 毫秒。

import { slotStartOf } from './clock.js';

export const DIRECTIONS = new Set(['entry', 'exit']);

// 岗位资质：manual=人工查验台, smart=智能通道监管, lead=带班, assist=异常协查。
export const QUALIFICATIONS = new Set(['manual', 'smart', 'lead', 'assist']);

function fail(message) {
  throw new Error(`领域数据无效：${message}`);
}

function needString(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} 必须是非空字符串`);
  return value;
}

function needInt(value, field, min = 0) {
  if (!Number.isInteger(value) || value < min) fail(`${field} 必须是不小于 ${min} 的整数`);
  return value;
}

// ---- 航班 ----
// version 单调递增；重复或更旧的版本由 service 层识别为重复更新并保持原结果。
export function makeFlight(input) {
  const flight = {
    id: needString(input.id, '航班 id'),
    version: needInt(input.version, '航班 version', 1),
    direction: input.direction,
    scheduledMs: needInt(input.scheduledMs, '航班 scheduledMs', 0),
    estimatedPax: needInt(input.estimatedPax, '航班 estimatedPax', 0),
    actualPax: input.actualPax == null ? null : needInt(input.actualPax, '航班 actualPax', 0),
  };
  if (!DIRECTIONS.has(flight.direction)) fail(`航班 ${flight.id} 方向必须是 entry 或 exit`);
  return Object.freeze(flight);
}

// 有效旅客量：实际量优先，未到时用预计量。
export function effectivePax(flight) {
  return flight.actualPax ?? flight.estimatedPax;
}

// ---- 通道与设备 ----
// kind: manual=人工查验通道, smart=智能（快捷）通道。
// 智能通道依赖在线设备；设备停用即通道能力降级为不可用。
export function makeLane(input) {
  const lane = {
    id: needString(input.id, '通道 id'),
    kind: input.kind,
    directions: [...new Set(input.directions)],
    deviceIds: [...(input.deviceIds ?? [])],
    // 每槽位（30 分钟）可查验的旅客数。
    capacityPerSlot: needInt(input.capacityPerSlot, '通道 capacityPerSlot', 1),
  };
  if (!['manual', 'smart'].includes(lane.kind)) fail(`通道 ${lane.id} 类型必须是 manual 或 smart`);
  if (lane.directions.length === 0 || lane.directions.some((d) => !DIRECTIONS.has(d))) {
    fail(`通道 ${lane.id} 的开放方向无效`);
  }
  if (lane.kind === 'smart' && lane.deviceIds.length === 0) fail(`智能通道 ${lane.id} 必须声明依赖设备`);
  return Object.freeze(lane);
}

export function makeDevice(input) {
  return Object.freeze({
    id: needString(input.id, '设备 id'),
    kind: needString(input.kind ?? 'gate', '设备 kind'),
    active: input.active !== false,
  });
}

// 通道在某时刻是否可用：智能通道要求全部依赖设备在线。
export function laneUsable(lane, devicesById) {
  if (lane.kind !== 'smart') return true;
  return lane.deviceIds.every((id) => devicesById.get(id)?.active === true);
}

// ---- 人员与班次 ----
export function makeOfficer(input) {
  const quals = [...new Set(input.qualifications)];
  if (quals.length === 0 || quals.some((q) => !QUALIFICATIONS.has(q))) {
    fail(`人员 ${input.id} 资质无效`);
  }
  return Object.freeze({
    id: needString(input.id, '人员 id'),
    qualifications: quals,
  });
}

// 班次：跨午夜只是 endMs > startMs 的普通区间。
// maxContinuousMin 连续执勤上限，minRestMin 班后最短休息。
export function makeShift(input) {
  const shift = {
    officerId: needString(input.officerId, '班次 officerId'),
    startMs: needInt(input.startMs, '班次 startMs', 0),
    endMs: needInt(input.endMs, '班次 endMs', 0),
    maxContinuousMin: needInt(input.maxContinuousMin ?? 240, '班次 maxContinuousMin', 1),
    minRestMin: needInt(input.minRestMin ?? 60, '班次 minRestMin', 0),
  };
  if (shift.endMs <= shift.startMs) fail(`人员 ${shift.officerId} 班次结束必须晚于开始`);
  return Object.freeze(shift);
}

// ---- 客流需求 ----
// 把一架航班的旅客量摊到到港/离港前后若干个槽位：
// 入境旅客在落地后 0–90 分钟到达查验区，出境旅客在起飞前 120–30 分钟到达。
// 权重为简单三角分布，重放时结果确定。
const WAVE = {
  entry: [
    { offsetMin: 0, weight: 0.5 },
    { offsetMin: 30, weight: 0.35 },
    { offsetMin: 60, weight: 0.15 },
  ],
  exit: [
    { offsetMin: -120, weight: 0.2 },
    { offsetMin: -90, weight: 0.35 },
    { offsetMin: -60, weight: 0.45 },
  ],
};

// 返回 Map<slotStartMs, Map<direction, pax>>，只统计 [fromMs, toMs) 内的槽位。
export function demandBySlot(flights, slotMs, fromMs, toMs) {
  const demand = new Map();
  for (const flight of flights) {
    const pax = effectivePax(flight);
    if (pax === 0) continue;
    for (const { offsetMin, weight } of WAVE[flight.direction]) {
      const at = slotStartOf(flight.scheduledMs + offsetMin * 60 * 1000, slotMs);
      if (at < fromMs || at >= toMs) continue;
      let dirMap = demand.get(at);
      if (!dirMap) demand.set(at, (dirMap = new Map()));
      dirMap.set(flight.direction, (dirMap.get(flight.direction) ?? 0) + Math.round(pax * weight));
    }
  }
  return demand;
}

// 峰值：需求最大的槽位及其旅客量，按方向分开统计。
export function peakSlots(demand) {
  const peaks = [];
  for (const [slotMsStart, dirMap] of [...demand.entries()].sort((a, b) => a[0] - b[0])) {
    const total = [...dirMap.values()].reduce((a, b) => a + b, 0);
    peaks.push({ slotStartMs: slotMsStart, byDirection: Object.fromEntries(dirMap), totalPax: total });
  }
  return peaks;
}

// 连续执勤检查：同一人员已排槽位（按开始时刻排序）中是否存在超过上限的连续段。
// slots: [{ startMs, endMs }]，slotMs 为槽位长度。
export function longestContinuousMin(slots) {
  if (slots.length === 0) return 0;
  const sorted = [...slots].sort((a, b) => a.startMs - b.startMs);
  let longest = 0;
  let runStart = sorted[0].startMs;
  let runEnd = sorted[0].endMs;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].startMs <= runEnd) {
      runEnd = Math.max(runEnd, sorted[i].endMs);
    } else {
      longest = Math.max(longest, runEnd - runStart);
      runStart = sorted[i].startMs;
      runEnd = sorted[i].endMs;
    }
  }
  longest = Math.max(longest, runEnd - runStart);
  return longest / (60 * 1000);
}
