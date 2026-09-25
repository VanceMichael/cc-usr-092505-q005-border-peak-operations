// 墙钟分钟时间模型：全部时间以 'YYYY-MM-DDTHH:MM' 表示，
// 分钟数从 Unix 纪元起线性累加，天然支持跨午夜班次与峰值计算。

export const MINUTE = 1;
export const HOUR = 60;
export const DAY = 24 * HOUR;

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// 'YYYY-MM-DDTHH:MM' -> 分钟整数
export function toMinutes(iso) {
  const m = ISO.exec(iso);
  if (!m) throw new Error(`时间格式应为 YYYY-MM-DDTHH:MM：${iso}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) {
    throw new Error(`时间取值越界：${iso}`);
  }
  // Date.UTC 仅作可靠的日历换算，输出仍是与时区无关的“墙钟分钟”。
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 60000);
}

// 分钟整数 -> 'YYYY-MM-DDTHH:MM'
export function toIso(minutes) {
  const dt = new Date(minutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}` +
    `T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}`;
}

// 在 ISO 时间上加减分钟
export function shift(iso, deltaMinutes) {
  return toIso(toMinutes(iso) + deltaMinutes);
}

export function diffMinutes(aIso, bIso) {
  return toMinutes(aIso) - toMinutes(bIso);
}

export function maxIso(a, b) {
  return toMinutes(a) >= toMinutes(b) ? a : b;
}

// 把 [start,end) 按 slotMinutes（默认 30）切成左闭右开时段
export function buildSlots(startIso, endIso, slotMinutes = 30) {
  const start = toMinutes(startIso);
  const end = toMinutes(endIso);
  if (end <= start) throw new Error('计划结束时间必须晚于开始时间');
  if (slotMinutes <= 0) throw new Error('时段长度必须为正');
  const slots = [];
  for (let t = start; t < end; t += slotMinutes) {
    slots.push({ start: toIso(t), end: toIso(Math.min(t + slotMinutes, end)) });
  }
  return slots;
}

// 判断时间点是否落在 [slotStart, slotEnd) 内
export function inSlot(instantIso, slot) {
  const t = toMinutes(instantIso);
  return t >= toMinutes(slot.start) && t < toMinutes(slot.end);
}

// 计算“自然日归属”：跨午夜的计划里，凌晨时段属于前一个勤务日。
export function dutyDate(iso) {
  return iso.slice(0, 10);
}

// 把 HH:MM 形式的班次起止挂到基准日上；end <= start 时视为跨午夜（结束日 +1）。
export function resolveShift(baseDate, startHHMM, endHHMM) {
  const start = `${baseDate}T${startHHMM}`;
  const nextDate = shift(`${baseDate}T00:00`, DAY).slice(0, 10);
  const crosses = toMinutes(`${baseDate}T${endHHMM}`) <= toMinutes(start);
  const end = crosses ? `${nextDate}T${endHHMM}` : `${baseDate}T${endHHMM}`;
  return { start, end, crossMidnight: crosses };
}
