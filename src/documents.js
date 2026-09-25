// 证件材料授权库：证件异常的材料明细只在授权检查范围内可见。
// 未授权角色只能看到案件编号、关联航班与人数，看不到任何材料内容。

export const ROLES = {
  commander: 'duty-commander',   // 边检值班长
  officer: 'inspection-officer', // 查验人员
  flightSupport: 'flight-support', // 航班保障人员
  cooperation: 'urgent-cooperation', // 异常协查人员
};

// 默认可见证件材料明细的角色（授权检查范围）。
const DOC_SCOPE_DEFAULT = [ROLES.commander, ROLES.cooperation];

export class DocumentVault {
  constructor() {
    this.docs = new Map();
  }

  // doc: { docId, caseRef, flightNo?, scope?, summary, materials }
  add(doc) {
    if (!doc || !doc.docId || !doc.caseRef) throw new Error('材料缺少 docId/caseRef');
    if (this.docs.has(doc.docId)) throw new Error(`材料编号重复：${doc.docId}`);
    this.docs.set(doc.docId, {
      docId: doc.docId,
      caseRef: doc.caseRef,
      flightNo: doc.flightNo ?? null,
      summary: doc.summary ?? '',
      materials: doc.materials ?? [],
      scope: doc.scope ?? DOC_SCOPE_DEFAULT,
      createdAt: doc.createdAt ?? null,
      handled: false,
    });
    return this.safeView([], doc.docId);
  }

  markHandled(docId) {
    const doc = this.docs.get(docId);
    if (doc) doc.handled = true;
  }

  // 按角色返回材料：不在授权范围内时剔除 materials 与摘要细节。
  safeView(viewerRoles, docId) {
    const doc = this.docs.get(docId);
    if (!doc) return null;
    const allowed = viewerRoles.some((r) => doc.scope.includes(r));
    return {
      docId: doc.docId,
      caseRef: doc.caseRef,
      flightNo: doc.flightNo,
      authorized: allowed,
      handled: doc.handled,
      ...(allowed
        ? { summary: doc.summary, materials: doc.materials, scope: doc.scope }
        : { materials: [] }),
    };
  }

  list(viewerRoles) {
    return [...this.docs.keys()].map((id) => this.safeView(viewerRoles, id));
  }
}
