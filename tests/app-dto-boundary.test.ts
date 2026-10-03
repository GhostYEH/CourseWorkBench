import { describe, expect, it } from 'vitest';
import { MAX_MATERIAL_BYTES, isStudyError, proposalSchema } from '@sew/study-contracts';
import type { KnowledgeRow, ProposalRow } from '@sew/study-storage';
import { toKnowledgePointDto, toProposalDto } from '../apps/learning/lib/server/dto';
import { assertMaterialSize } from '../apps/learning/lib/server/service';

/**
 * 本地 Next 应用层 DTO 边界回归（缺陷 A1/A4）。
 *
 * - A1：候选/知识点必须经 DTO 映射，候选携带 `revision` 供乐观并发，
 *   且不得泄露存储内部字段 `originProposalId`。
 * - A4：材料大小上限必须可判定（错误码 + details），而不是把巨型文件读入内存。
 */

const proposalRow = (): ProposalRow => ({
  proposalId: 'prop1',
  name: '单调递增',
  concept: 'x1 < x2 时 f(x1) < f(x2)',
  conditions: '',
  scopeStatus: 'in_syllabus',
  recordScope: 'formal',
  prerequisites: [],
  evidence: [
    {
      materialId: 'mat1',
      revision: 1,
      segmentId: 'S002',
      use: 'concept_basis',
      fingerprint: 'fp',
      excerpt: '原文',
    },
  ],
  acceptance: '',
  priority: 'medium',
  proposedBy: 'ai',
  status: 'pending',
  mechanical: { passed: true, checks: [] },
  reviewNote: null,
  reviewProvenance: null,
  createdAt: new Date().toISOString(),
  reviewedAt: null,
  revision: 7,
});

describe('A1 候选 DTO 边界', () => {
  it('toProposalDto 输出含 revision（乐观并发依赖）', () => {
    const dto = toProposalDto(proposalRow());
    expect(dto.revision).toBe(7);
    expect(proposalSchema.safeParse(dto).success).toBe(true);
  });

  it('toProposalDto 不含存储内部字段 originProposalId', () => {
    const dto = toProposalDto(proposalRow());
    expect(dto).not.toHaveProperty('originProposalId');
  });

  it('toKnowledgePointDto 不含 originProposalId', () => {
    const row: KnowledgeRow = {
      knowledgeId: 'kp1',
      name: '单调递增',
      concept: 'x1 < x2 时 f(x1) < f(x2)',
      conditions: '',
      sourceStatus: 'verified',
      recordScope: 'formal',
      reviewProvenance: 'user_semantic',
      scopeStatus: 'in_syllabus',
      masteryStatus: 'untested',
      prerequisites: [],
      evidence: [],
      acceptance: '',
      priority: 'medium',
      originProposalId: 'prop1',
      revision: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const dto = toKnowledgePointDto(row);
    expect(dto).not.toHaveProperty('originProposalId');
    expect(dto.revision).toBe(3);
  });
});

describe('A4 材料大小上限可判定', () => {
  it('恰好等于上限不报错', () => {
    expect(() => assertMaterialSize(MAX_MATERIAL_BYTES)).not.toThrow();
  });

  it('超限抛 MATERIAL_TYPE_UNSUPPORTED 且 details 说明 too_large', () => {
    try {
      assertMaterialSize(MAX_MATERIAL_BYTES + 1);
      throw new Error('应当抛出超限错误');
    } catch (error) {
      expect(isStudyError(error)).toBe(true);
      if (!isStudyError(error)) return;
      expect(error.code).toBe('MATERIAL_TYPE_UNSUPPORTED');
      expect(error.pending).toBe(false);
      expect(error.details).toMatchObject({ reason: 'too_large', limit: MAX_MATERIAL_BYTES });
    }
  });
});
