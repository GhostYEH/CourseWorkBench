/**
 * 查询装配复用。
 *
 * 页面与 API 需要「知识点 + 准入结论」的联合视图。逐条调用 checkAdmission 会产生
 * N 次查询；这里一次批量取回，再由视图回答每个知识点的准入结果。
 */

import type { AdmissionResultDto } from '@sew/study-contracts';
import type { KnowledgeRow } from '@sew/study-storage';
import type { Session } from './service';

export type AdmissionBlocked = AdmissionResultDto['blocked'][number];

export interface KnowledgeView {
  /** 权威知识点行，按存储顺序。 */
  rows: KnowledgeRow[];
  /** 准入通过的知识点编号。 */
  admittedIds: ReadonlySet<string>;
  /** 被阻断的知识点编号 → 阻断原因。 */
  blockedById: ReadonlyMap<string, AdmissionBlocked>;
  /** 该知识点的准入结论（用于逐条展示，不额外查询）。 */
  admissionFor: (knowledgeId: string) => AdmissionResultDto;
}

export const buildKnowledgeView = (session: Session): KnowledgeView => {
  const rows = session.store.listKnowledge();
  const ids = rows.map((row) => row.knowledgeId);
  const result: AdmissionResultDto =
    ids.length > 0
      ? session.store.checkAdmission(ids)
      : { allowed: true, admitted: [], blocked: [] };

  const admittedIds = new Set(result.admitted);
  const blockedById = new Map(result.blocked.map((item) => [item.knowledgeId, item]));

  const admissionFor = (knowledgeId: string): AdmissionResultDto => {
    if (admittedIds.has(knowledgeId)) {
      return { allowed: true, admitted: [knowledgeId], blocked: [] };
    }
    const blocked = blockedById.get(knowledgeId);
    return { allowed: false, admitted: [], blocked: blocked ? [blocked] : [] };
  };

  return { rows, admittedIds, blockedById, admissionFor };
};
