/**
 * 知识候选审核与权威表变更（《规划书》5.3 / 5.4）。
 *
 * 状态转换：
 *   AI 提出候选 → 机械检查 → 人工对照审核 → 版本校验及事务提交 → 已核实知识点
 * 机械失败或语义证据不足：待核实。语义明确错误：已拒绝。
 * 材料被替换或引用失效：关联知识点转为已失效，暂停教学准入。
 */

import { StudyError } from '@sew/study-contracts';
import type { ReviewDecision, SourceStatus } from '@sew/study-contracts';
import type { MechanicalCheckResult } from './source';

export interface ReviewDecisionInput {
  decision: ReviewDecision;
  /** 客户端基于的候选版本，用于乐观并发校验。 */
  expectedRevision: number;
  /** 服务端当前版本。 */
  currentRevision: number;
  mechanical: MechanicalCheckResult;
  semanticReviewed: boolean;
  note?: string;
}

export interface ReviewDecisionResult {
  status: 'approved' | 'rejected' | 'needs_material' | 'pending';
  /** 是否应在同一事务内写入权威知识点表。 */
  createsKnowledgePoint: boolean;
  note: string;
}

export const decideProposal = (input: ReviewDecisionInput): ReviewDecisionResult => {
  if (input.expectedRevision !== input.currentRevision) {
    throw new StudyError('VERSION_CONFLICT', {
      expectedRevision: input.expectedRevision,
      currentRevision: input.currentRevision,
    });
  }

  if (input.decision === 'rejected') {
    return { status: 'rejected', createsKnowledgePoint: false, note: input.note ?? '语义明确错误，已拒绝' };
  }

  if (input.decision === 'needs_material') {
    return {
      status: 'needs_material',
      createsKnowledgePoint: false,
      note: input.note ?? '证据不足，保留待核实并等待补充材料',
    };
  }

  // decision === 'approved'
  if (!input.mechanical.passed) {
    const failure = input.mechanical.checks.find((c) => !c.ok);
    throw new StudyError('SOURCE_MISSING', {
      failedChecks: input.mechanical.checks.filter((c) => !c.ok).map((c) => c.code),
      detail: failure?.detail,
    });
  }

  if (!input.semanticReviewed) {
    // 机械通过只代表引用可定位；必须由人对照原文判断语义支持。
    throw new StudyError(
      'KNOWLEDGE_NOT_VERIFIED',
      { reason: 'semantic_review_missing' },
      '引用可定位，但还需对照原文确认它是否支持这个知识点',
    );
  }

  return {
    status: 'approved',
    createsKnowledgePoint: true,
    note: input.note ?? '已通过机械检查与人工语义审核',
  };
};

export interface MaterialChangeImpact {
  knowledgeId: string;
  name: string;
  affectedMaterialIds: string[];
}

/**
 * 材料更新后计算受影响的已核实知识点。命中即转为已失效，历史保留审计，
 * 不静默改写历史讲义，也不自动重新核实。
 */
export const computeInvalidation = (
  points: ReadonlyArray<{
    knowledgeId: string;
    name: string;
    sourceStatus: SourceStatus;
    evidence: ReadonlyArray<{ materialId: string; revision: number }>;
  }>,
  currentRevisions: Record<string, number>,
): MaterialChangeImpact[] => {
  const impacts: MaterialChangeImpact[] = [];
  for (const point of points) {
    if (point.sourceStatus !== 'verified') continue;
    const affected = point.evidence
      .filter((ref) => {
        const current = currentRevisions[ref.materialId];
        return current === undefined || current !== ref.revision;
      })
      .map((ref) => ref.materialId);
    if (affected.length > 0) {
      impacts.push({ knowledgeId: point.knowledgeId, name: point.name, affectedMaterialIds: affected });
    }
  }
  return impacts;
};
