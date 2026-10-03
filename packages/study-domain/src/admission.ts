/**
 * 生成准入（《规划书》5.3 第三道检查）。
 *
 * 在每次生成和发布前，确认所用知识点已核实、当前仍有效、范围合规，
 * 且所有必要前置知识也满足要求。来源不足只阻断受影响的知识点与任务，
 * 其他已经核实的任务仍可执行。
 */

import type { AdmissionResultDto, ScopeStatus, SourceStatus } from '@sew/study-contracts';

export interface KnowledgeRecord {
  knowledgeId: string;
  name: string;
  sourceStatus: SourceStatus;
  scopeStatus: ScopeStatus;
  prerequisites: string[];
  evidence: ReadonlyArray<{ materialId: string; revision: number }>;
}

export interface AdmissionInput {
  knowledgeIds: string[];
  /** 当前权威知识点表（含待核实项，用于解释阻断原因）。 */
  table: ReadonlyMap<string, KnowledgeRecord>;
  currentRevisions: Record<string, number>;
}

type BlockReason = { code: string; message: string; missing: string[] };

/** 单点校验（不含前置递归）。 */
const evaluateOne = (
  record: KnowledgeRecord | undefined,
  currentRevisions: Record<string, number>,
): BlockReason | null => {
  if (!record) {
    return { code: 'KNOWLEDGE_NOT_VERIFIED', message: '知识点不存在或尚未建立', missing: [] };
  }
  if (record.sourceStatus === 'invalidated') {
    return {
      code: 'KNOWLEDGE_INVALIDATED',
      message: '关联来源已失效，需重新核实',
      missing: record.evidence.map((e) => e.materialId),
    };
  }
  if (record.sourceStatus !== 'verified') {
    return {
      code: 'KNOWLEDGE_NOT_VERIFIED',
      message: '该知识点尚未核实，暂不能用于课程和出题',
      missing: record.evidence.map((e) => e.materialId),
    };
  }
  if (record.scopeStatus === 'scope_pending' || record.scopeStatus === 'out_of_scope') {
    return { code: 'KNOWLEDGE_SCOPE_INVALID', message: '范围状态不合规，需先确认考纲映射', missing: [] };
  }
  if (record.evidence.length === 0) {
    return { code: 'SOURCE_MISSING', message: '缺少支持原文，暂不能用于课程和出题', missing: [] };
  }
  const stale = record.evidence.filter((ref) => currentRevisions[ref.materialId] !== ref.revision);
  if (stale.length > 0) {
    return {
      code: 'SOURCE_REVISION_STALE',
      message: '材料已更新，引用指向旧版本，需重新核实',
      missing: stale.map((ref) => ref.materialId),
    };
  }
  return null;
};

export const checkAdmission = (input: AdmissionInput): AdmissionResultDto => {
  const admitted: string[] = [];
  const blocked: AdmissionResultDto['blocked'] = [];
  const memo = new Map<string, BlockReason | null>();

  const resolve = (knowledgeId: string, stack: Set<string>): BlockReason | null => {
    const cached = memo.get(knowledgeId);
    if (cached !== undefined) return cached;

    // 循环前置依赖视为不满足，避免无限递归。
    if (stack.has(knowledgeId)) {
      const cycle: BlockReason = {
        code: 'PREREQUISITE_UNSATISFIED',
        message: '前置依赖形成环，需人工修正',
        missing: [],
      };
      memo.set(knowledgeId, cycle);
      return cycle;
    }

    const record = input.table.get(knowledgeId);
    const own = evaluateOne(record, input.currentRevisions);
    if (own) {
      memo.set(knowledgeId, own);
      return own;
    }

    stack.add(knowledgeId);
    for (const prerequisiteId of record?.prerequisites ?? []) {
      const reason = resolve(prerequisiteId, stack);
      if (reason) {
        const wrapped: BlockReason = {
          code: 'PREREQUISITE_UNSATISFIED',
          message: `必要前置知识尚未满足：${prerequisiteId}`,
          missing: [prerequisiteId],
        };
        stack.delete(knowledgeId);
        memo.set(knowledgeId, wrapped);
        return wrapped;
      }
    }
    stack.delete(knowledgeId);

    memo.set(knowledgeId, null);
    return null;
  };

  for (const knowledgeId of input.knowledgeIds) {
    const reason = resolve(knowledgeId, new Set());
    if (reason) {
      blocked.push({
        knowledgeId,
        code: reason.code,
        message: reason.message,
        missing: reason.missing,
      });
    } else if (!admitted.includes(knowledgeId)) {
      admitted.push(knowledgeId);
    }
  }

  return { allowed: blocked.length === 0, admitted, blocked };
};
