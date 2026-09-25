import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Clock } from '../src/clock.js';
import { PeakService, ROLES } from '../src/service.js';

// 固定脚本：用固定航班与时钟重放一次完整双节高峰（20:00-02:00，跨午夜）。
// 不接入任何真实机场设备；同一脚本跑两次，所有读取水位必须深度一致。
// 脚本同时被 scripts/replay.mjs 使用，保持单一事实来源。
const ROLE_BY_NAME = {
  'duty-commander': ROLES.commander,
  'flight-support': ROLES.flightSupport,
};

function checkpoint(svc) {
  const p = svc.snapshot().plan;
  return {
    now: svc.now(),
    planVersion: svc.snapshot().planVersion,
    open: p.schedule.openBySlot.map((o) => [
      o.slotIndex,
      o.lanes.map((l) => `${l.laneId}:${l.officerId}`).sort(),
      o.frozen === true ? 1 : 0,
    ]),
    urgent: p.schedule.urgentAssign.map((u) => [u.slotIndex, u.caseId, [...u.officerIds].sort()]),
    reserves: p.schedule.reserves.map((r) => [r.slotIndex, r.officerIds]),
    gaps: p.schedule.gaps.map((g) => [g.slotIndex, g.kind, g.direction ?? '', g.laneId ?? '', g.detail]),
    backlog: p.backlog.map((b) => [b.slotIndex, b.totalQueue]),
    peak: [p.peak.index, p.peak.pax],
  };
}

async function runReplay() {
  const [scenario, SCRIPT] = await Promise.all([
    readFile(new URL('../fixtures/peak-scenario.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../fixtures/replay-script.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const svc = new PeakService({ clock: new Clock(SCRIPT[0].at), scenario });
  const trace = [];
  for (const step of SCRIPT) {
    svc.clock.jumpTo(step.at);
    if (step.kind === 'publish') {
      trace.push({ at: step.at, result: svc.publish() });
    } else if (step.kind === 'event') {
      trace.push({ at: step.at, eventId: step.event.eventId, result: svc.submitEvent(step.event) });
    } else {
      trace.push({ at: step.at,
        summary: svc.handoverSummary({ viewerRoles: [ROLE_BY_NAME[step.role]] }) });
    }
    trace.push({ at: step.at, plan: checkpoint(svc) });
  }
  return trace;
}

test('完整高峰重放：关键事件结果符合业务规则', async () => {
  const trace = await runReplay();
  const results = trace.filter((t) => t.result).map((t) => t.result);

  // 发布与正常事件成功。
  assert.equal(results[0].ok, true);
  const byEvent = Object.fromEntries(
    trace.filter((t) => t.eventId).map((t) => [t.eventId, t.result]),
  );
  assert.equal(byEvent['f-actual'].ok, true);
  assert.equal(byEvent['urg-1'].ok, true);
  assert.equal(byEvent['f-delay'].ok, true);
  assert.equal(byEvent['out-1'].ok, true);
  assert.equal(byEvent['doc-1'].ok, true);
  assert.equal(byEvent['swap-a'].ok, true);
  assert.equal(byEvent['shift-1'].ok, true);
  assert.equal(byEvent['res-1'].ok, true);

  // 重复航班更新保持原结果（即使携带的航班版本不同）。
  assert.deepEqual(byEvent['f-delay'], byEvent['f-delay']);
  const delayResults = trace.filter((t) => t.eventId === 'f-delay');
  assert.equal(delayResults.length, 2);
  assert.deepEqual(delayResults[0].result, delayResults[1].result);

  // 较晚的通道争用被拒绝。
  assert.equal(byEvent['swap-b'].ok, false);
  assert.equal(byEvent['swap-b'].reason, 'resource-conflict');
});

test('完整高峰重放：换岗锁定落实到 23:30 的 EM2', async () => {
  const trace = await runReplay();
  const last = trace[trace.length - 1].plan;
  const slot2330 = last.open.find(([idx]) => idx === 7); // 23:30 是第 8 个时段（index 7）
  assert.ok(slot2330[1].some((x) => x === 'EM2:M07'));
  assert.equal(slot2330[1].some((x) => x === 'EM2:M02'), false);
});

test('完整高峰重放：已开始时段在后续修订中保持冻结', async () => {
  const trace = await runReplay();
  // 22:05 之后的所有计划检查点：20:00/20:30/21:00/21:30/22:00 五个时段均冻结。
  const afterDoc = trace.filter((t) => t.at >= '2026-10-01T22:05' && t.plan);
  assert.ok(afterDoc.length > 0);
  for (const t of afterDoc) {
    for (const [idx, , frozen] of t.plan.open) {
      if (idx <= 4) {
        const openAt = t.plan.open.find(([i]) => i === idx);
        assert.equal(openAt[2], 1, `时段 ${idx} 在 ${t.at} 应冻结`);
      }
    }
  }
});

test('完整高峰重放：跨午夜峰值与未处理异常水位正确', async () => {
  const trace = await runReplay();
  const summaries = trace.filter((t) => t.summary).map((t) => t.summary);
  const last = summaries[summaries.length - 1];
  assert.equal(last.watermark.nowIso, '2026-10-02T00:40');
  // DOC-1 已在 00:35 处理，交班清单不再包含。
  assert.equal(last.unhandledAnomalies.docs.some((d) => d.docId === 'DOC-1'), false);
  // 协查 C-101 已结束，也不再出现。
  assert.equal(last.unhandledAnomalies.cases.some((c) => c.caseId === 'C-101'), false);
  // 峰值仍落在计划窗口内（跨午夜计算正常）。
  assert.ok(last.peak.slot.start >= '2026-10-01T20:00');
  assert.ok(last.peak.slot.start < '2026-10-02T02:00');
});

test('完整高峰重放：授权角色看不到证件材料明细', async () => {
  const trace = await runReplay();
  const support = trace.filter((t) => t.summary && t.at === '2026-10-01T23:40')[0].summary;
  const doc = support.unhandledAnomalies.docs.find((d) => d.docId === 'DOC-1');
  assert.equal(doc.authorized, false);
  assert.deepEqual(doc.materials, []);
});

test('确定性：同一脚本独立重放两次，所有检查点深度一致', async () => {
  const a = await runReplay();
  const b = await runReplay();
  assert.deepEqual(a, b);
});
