// 可注入时钟：测试用固定时间或脚本步进重放一次完整高峰；
// 生产可替换为真实墙钟实现。系统内所有“现在”只能从时钟读取。

import { shift, toMinutes } from './time.js';

export class Clock {
  constructor(initialIso) {
    if (!initialIso) throw new Error('时钟必须给定初始时间');
    this.nowIso = initialIso;
  }

  now() {
    return this.nowIso;
  }

  // 推进若干分钟（重放用）
  advance(minutes) {
    if (minutes < 0) throw new Error('时钟只能向前推进');
    this.nowIso = shift(this.nowIso, minutes);
    return this.nowIso;
  }

  // 直接跳到指定时间（用于按脚本重放事件）
  jumpTo(iso) {
    if (toMinutes(iso) < toMinutes(this.nowIso)) {
      throw new Error('时钟不能回拨');
    }
    this.nowIso = iso;
    return this.nowIso;
  }
}
