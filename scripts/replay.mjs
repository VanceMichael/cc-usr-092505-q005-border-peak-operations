// 固定航班 + 固定时钟重放一次完整双节高峰，逐水位打印值守状态。
// 用法：node scripts/replay.mjs
// 只读仓库内夹具，不接入任何真实机场设备。重放脚本是自动化用例的同一事实来源。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Clock } from '../src/clock.js';
import { PeakService, ROLES } from '../src/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) =>
  readFile(join(here, '..', 'fixtures', name), 'utf8').then(JSON.parse);

const [scenario, SCRIPT] = await Promise.all([
  read('peak-scenario.json'),
  read('replay-script.json'),
]);

const ROLE_BY_NAME = {
  'duty-commander': ROLES.commander,
  'flight-support': ROLES.flightSupport,
};

const svc = new PeakService({ clock: new Clock(SCRIPT[0].at), scenario });
for (const step of SCRIPT) {
  svc.clock.jumpTo(step.at);
  if (step.kind === 'publish') {
    const r = svc.publish();
    console.log(`[${step.at}] 发布计划 v${r.planVersion}，峰值 ${r.peak.pax} 人 @ ${r.peak.slot.start}`);
  } else if (step.kind === 'event') {
    const r = svc.submitEvent(step.event);
    const tag = r.ok ? '接受' : `拒绝(${r.reason})`;
    console.log(`[${step.at}] 事件 ${step.event.eventId ?? step.event.type}：${tag}${
      r.basis ? ` —— ${r.basis}` : ''}${r.detail ? ` —— ${r.detail}` : ''}`);
  } else {
    const s = svc.handoverSummary({ viewerRoles: [ROLE_BY_NAME[step.role]] });
    console.log(`[${step.at}] 交班水位 v${s.watermark.planVersion}/事件#${s.watermark.eventSeq}`);
    console.log(`  当前时段 ${s.currentSlot?.start.slice(11)} 开放通道：${
      s.openLanes.map((l) => `${l.laneId}(${l.officerId})`).join(' ') || '无'}`);
    if (s.openCases.length) {
      console.log(`  在岗协查：${s.openCases.map((c) => `${c.caseId}[${c.officerIds.join(',')}]`).join(' ')}`);
    }
    if (s.nextSlot) {
      console.log(`  下一时段 ${s.nextSlot.start.slice(11)} 缺口 ${s.nextSlotGaps.length} 项，` +
        `队列积压 ${s.nextSlotQueue?.totalQueue ?? 0} 人，预留警力 ${s.nextSlotReserves.length} 人`);
      for (const g of s.nextSlotGaps) {
        console.log(`    - [${g.kind}/${g.direction}] ${g.detail}`);
      }
    }
    console.log(`  调整依据 ${s.adjustments.length} 条；未处理材料 ${s.unhandledAnomalies.docs.length} 件、` +
      `协查 ${s.unhandledAnomalies.cases.length} 起`);
  }
}
