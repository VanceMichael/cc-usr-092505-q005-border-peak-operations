// 航班版本流与客流压力测算。
//
// 版本规则：
// - 每个航班维护单调递增的 version，更新必须携带 expectedVersion，过期版本被拒绝；
// - updateId 是幂等键：同一个 updateId 重放返回首次的结果（“重复航班更新保持原结果”）。
//
// 压力模型（全部由固定参数推算，便于确定性重放）：
// - 入境航班：到达时刻起 [revisedIso, +arrivalWindowMinutes) 内产生入境查验压力；
// - 出境航班：起飞前 [revisedIso-departureLeadMinutes, revisedIso) 产生出境查验压力；
// - 客流取值：actualPax 已知用实际，否则用 estPax；
// - 证件异常旅客必须走人工通道；普通旅客按 smartEligibleShare 划分自助/人工。
// - 证件异常“材料明细”不在本模块保存，只保留人数；明细由授权文档库管理。

import { toMinutes } from './time.js';

export class FlightFeed {
  constructor(seedFlights = []) {
    this.flights = new Map();
    for (const f of seedFlights) this._seed(f);
  }

  _seed(f) {
    if (!f.flightNo || !f.direction || !f.scheduledIso) {
      throw new Error('航班缺少 flightNo/direction/scheduledIso');
    }
    if (!['arrival', 'departure'].includes(f.direction)) {
      throw new Error(`航班方向非法：${f.flightNo}`);
    }
    this.flights.set(f.flightNo, {
      flightNo: f.flightNo,
      direction: f.direction,
      scheduledIso: f.scheduledIso,
      revisedIso: f.revisedIso ?? f.scheduledIso,
      estPax: f.estPax ?? 0,
      actualPax: f.actualPax ?? null,
      docAnomalyPax: f.docAnomalyPax ?? 0,
      version: 0,
    });
  }

  get(flightNo) {
    const f = this.flights.get(flightNo);
    return f ? { ...f } : undefined;
  }

  list() {
    return [...this.flights.values()].map((f) => ({ ...f }));
  }

  // update: { flightNo, updateId, expectedVersion, revisedIso?, estPax?, actualPax?, docAnomalyPax? }
  applyUpdate(update) {
    if (!update || !update.flightNo || !update.updateId) {
      return { ok: false, reason: 'bad-update' };
    }
    const f = this.flights.get(update.flightNo);
    if (!f) return { ok: false, reason: 'unknown-flight' };

    // 幂等：同一 updateId 直接回放首次结果（含被拒绝的结果）。
    f._results ??= new Map();
    const prior = f._results.get(update.updateId);
    if (prior) return cloneResult(prior);

    if (update.expectedVersion !== f.version) {
      const result = { ok: false, reason: 'stale-version', flightNo: f.flightNo, currentVersion: f.version };
      f._results.set(update.updateId, result);
      return cloneResult(result);
    }

    if (update.revisedIso !== undefined) {
      const t = toMinutes(update.revisedIso);
      if (t < toMinutes(f.scheduledIso) - 24 * 60 || t > toMinutes(f.scheduledIso) + 24 * 60) {
        const result = { ok: false, reason: 'revised-time-out-of-range' };
        f._results.set(update.updateId, result);
        return cloneResult(result);
      }
      f.revisedIso = update.revisedIso;
    }
    for (const k of ['estPax', 'actualPax', 'docAnomalyPax']) {
      if (update[k] !== undefined) f[k] = update[k];
    }

    f.version += 1;
    const result = { ok: true, flightNo: f.flightNo, version: f.version, flight: { ...f } };
    delete result.flight._results;
    f._results.set(update.updateId, result);
    return cloneResult(result);
  }
}

function cloneResult(r) {
  return JSON.parse(JSON.stringify(r));
}

export function paxOf(flight) {
  return flight.actualPax ?? flight.estPax;
}

// 航班产生压力的时间窗（分钟整数）
export function pressureWindow(flight, config) {
  const t = toMinutes(flight.revisedIso);
  if (flight.direction === 'arrival') {
    return { start: t, end: t + config.arrivalWindowMinutes };
  }
  return { start: t - config.departureLeadMinutes, end: t };
}

function emptyDemand() {
  return { manualPax: 0, smartPax: 0, totalPax: 0, flights: [] };
}

// 最大余数法把份额取整，保证各时段分配合计等于总人数。
function allocateInteger(weights, total) {
  if (weights.length === 0 || total === 0) return weights.map(() => 0);
  const floats = weights.map((w) => w * total);
  const floors = floats.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = floats
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => (b.frac - a.frac) || a.i - b.i);
  for (let k = 0; k < remainder; k += 1) floors[order[k % order.length].i] += 1;
  return floors;
}

// 按 slots 顺序投影全部航班压力，返回与 slots 对齐的 { entry, exit } 需求数组。
export function projectDemand(feed, slots, config) {
  const out = slots.map(() => ({ entry: emptyDemand(), exit: emptyDemand() }));
  for (const f of feed.list()) {
    const total = paxOf(f);
    if (total <= 0) continue;
    const win = pressureWindow(f, config);
    const overlap = slots.map((s) => {
      const a = Math.max(toMinutes(s.start), win.start);
      const b = Math.min(toMinutes(s.end), win.end);
      return Math.max(0, b - a);
    });
    const covered = overlap.reduce((a, b) => a + b, 0);
    if (covered === 0) continue;

    const normal = Math.max(0, total - f.docAnomalyPax);
    const manualNormal = Math.round(normal * (1 - config.smartEligibleShare));
    const manualTotal = f.docAnomalyPax + manualNormal;
    const smartTotal = total - manualTotal;

    const weights = overlap.map((m) => m / covered);
    const manualAlloc = allocateInteger(weights, manualTotal);
    const smartAlloc = allocateInteger(weights, smartTotal);
    const paxAlloc = allocateInteger(weights, total);

    const dirKey = f.direction === 'arrival' ? 'entry' : 'exit';
    slots.forEach((_, i) => {
      if (paxAlloc[i] <= 0) return;
      const d = out[i][dirKey];
      d.manualPax += manualAlloc[i];
      d.smartPax += smartAlloc[i];
      d.totalPax += paxAlloc[i];
      d.flights.push({ flightNo: f.flightNo, pax: paxAlloc[i] });
    });
  }
  return out;
}

// 峰值时段（跨午夜窗口照常工作）。
export function peakSlot(slots, demand) {
  let best = null;
  demand.forEach((d, i) => {
    const total = d.entry.totalPax + d.exit.totalPax;
    if (!best || total > best.pax) best = { index: i, slot: slots[i], pax: total };
  });
  return best ?? { index: -1, slot: null, pax: 0 };
}
