// 可注入时钟：生产用系统时钟，测试用固定时钟。
// 所有时刻一律使用 epoch 毫秒（UTC），跨午夜班次只是普通的数值区间，
// 不做"几点"级别的本地时间运算，避免跨日比较出错。

export function systemClock() {
  return { now: () => Date.now() };
}

// 固定时钟：now() 恒定返回构造时刻，advance(ms) 显式推进，便于重放高峰。
export function fixedClock(startMs) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('时钟只能向前推进');
      current += ms;
      return current;
    },
  };
}

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

// 半开区间 [startMs, endMs) 是否重叠。
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// 把时刻向下对齐到槽位边界（如 30 分钟一格）。
export function slotStartOf(ms, slotMs) {
  return Math.floor(ms / slotMs) * slotMs;
}
