import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError } from '@sew/study-contracts';
import type { ScopeStatus, SourceStatus } from '@sew/study-contracts';
import { computeSyllabusCoverage, validateSyllabusMapping } from '@sew/study-domain';
import type { SyllabusCoveragePointRecord, SyllabusItemRecord } from '@sew/study-domain';
import { StudyStore, ensureProjectLayout, projectPaths } from '@sew/study-storage';

/**
 * 考纲原子项与覆盖（《规划书》8.1）。
 *
 * 这里固定的是计数口径：分母是登记条目，分子只算必要要素全部覆盖的条目，
 * 重复映射不重复计数，必要前置与未准入知识点不进分子。
 */

const expectCode = (action: () => unknown, code: string, reason?: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    if (reason !== undefined) {
      expect((error as StudyError).details?.['reason']).toBe(reason);
    }
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

const point = (
  knowledgeId: string,
  overrides: Partial<SyllabusCoveragePointRecord> = {},
): SyllabusCoveragePointRecord => ({
  knowledgeId,
  scopeStatus: 'in_syllabus' as ScopeStatus,
  sourceStatus: 'verified' as SourceStatus,
  syllabusItemId: 'syl-1',
  syllabusRequirementKey: 'def',
  ...overrides,
});

const item = (itemId: string, keys: string[]): SyllabusItemRecord => ({
  itemId,
  code: itemId.toUpperCase(),
  label: `条目 ${itemId}`,
  recordScope: 'formal',
  requirements: keys.map((key) => ({ key, text: `${key} 的说明` })),
});

describe('考纲覆盖计数（纯领域）', () => {
  it('多个知识点命中同一要素只计一次，要素齐全才算完整覆盖', () => {
    const items = [item('syl-1', ['def', 'cond']), item('syl-2', ['def', 'example']), item('syl-3', ['def'])];
    const coverage = computeSyllabusCoverage({
      items,
      points: [
        point('kp1', { syllabusRequirementKey: 'def' }),
        point('kp2', { syllabusRequirementKey: 'def' }),
        point('kp3', { syllabusRequirementKey: 'cond' }),
        point('kp4', { syllabusItemId: 'syl-2', syllabusRequirementKey: 'def' }),
      ],
      admittedIds: new Set(['kp1', 'kp2', 'kp3', 'kp4']),
    });

    expect(coverage.totalItems).toBe(3);
    expect(coverage.coveredItems).toBe(1);
    expect(coverage.partialItems).toBe(1);
    expect(coverage.uncoveredItems).toBe(1);
    expect(coverage.coverageRate).toBeCloseTo(1 / 3);
    expect(coverage.items.find((entry) => entry.itemId === 'syl-1')).toMatchObject({
      coveredRequirements: 2,
      totalRequirements: 2,
      state: 'covered',
    });
    expect(coverage.items.find((entry) => entry.itemId === 'syl-2')).toMatchObject({
      coveredRequirements: 1,
      totalRequirements: 2,
      state: 'partial',
    });
  });

  it('必要前置、未核实与未准入的知识点不进分子；未登记条目时没有分母', () => {
    const items = [item('syl-1', ['def'])];
    const points = [
      point('kp-prereq', { scopeStatus: 'prerequisite' }),
      point('kp-pending', { sourceStatus: 'pending' }),
      point('kp-blocked', {}),
    ];
    const coverage = computeSyllabusCoverage({
      items,
      points,
      admittedIds: new Set(['kp-prereq', 'kp-pending']),
    });
    expect(coverage.coveredItems).toBe(0);
    expect(coverage.uncoveredItems).toBe(1);
    expect(coverage.coverageRate).toBe(0);

    const empty = computeSyllabusCoverage({ items: [], points: [point('kp1')], admittedIds: new Set(['kp1']) });
    expect(empty.totalItems).toBe(0);
    expect(empty.coverageRate).toBeNull();

    const unmapped = computeSyllabusCoverage({
      items,
      points: [point('kp-none', { syllabusItemId: null, syllabusRequirementKey: null })],
      admittedIds: new Set(['kp-none']),
    });
    expect(unmapped.unmappedKnowledge).toBe(1);
    expect(unmapped.coveredItems).toBe(0);
  });
});

describe('考纲映射校验（纯领域）', () => {
  const formalItem = item('syl-1', ['def']);

  it('条目登记后「考纲内」候选必须给出映射；未登记条目时允许留空', () => {
    expectCode(
      () =>
        validateSyllabusMapping({
          scopeStatus: 'in_syllabus',
          recordScope: 'formal',
          mapping: null,
          item: formalItem,
          mappingRequired: true,
        }),
      'SYLLABUS_ITEM_NOT_FOUND',
      'mapping_required',
    );
    expect(
      validateSyllabusMapping({
        scopeStatus: 'in_syllabus',
        recordScope: 'formal',
        mapping: null,
        item: null,
        mappingRequired: false,
      }),
    ).toBeNull();
  });

  it('条目不存在、跨记录范围、要素不属于该条目与非考纲内映射都被拒绝', () => {
    expectCode(
      () =>
        validateSyllabusMapping({
          scopeStatus: 'in_syllabus',
          recordScope: 'formal',
          mapping: { itemId: 'missing', requirementKey: 'def' },
          item: null,
          mappingRequired: true,
        }),
      'SYLLABUS_ITEM_NOT_FOUND',
    );
    expectCode(
      () =>
        validateSyllabusMapping({
          scopeStatus: 'in_syllabus',
          recordScope: 'formal',
          mapping: { itemId: 'syl-demo', requirementKey: 'def' },
          item: { ...formalItem, itemId: 'syl-demo', recordScope: 'demo' },
          mappingRequired: true,
        }),
      'SYLLABUS_ITEM_NOT_FOUND',
      'record_scope_mismatch',
    );
    expectCode(
      () =>
        validateSyllabusMapping({
          scopeStatus: 'in_syllabus',
          recordScope: 'formal',
          mapping: { itemId: 'syl-1', requirementKey: 'nope' },
          item: formalItem,
          mappingRequired: true,
        }),
      'SYLLABUS_REQUIREMENT_NOT_FOUND',
    );
    expectCode(
      () =>
        validateSyllabusMapping({
          scopeStatus: 'prerequisite',
          recordScope: 'formal',
          mapping: { itemId: 'syl-1', requirementKey: 'def' },
          item: formalItem,
          mappingRequired: true,
        }),
      'SYLLABUS_MAPPING_NOT_ALLOWED',
    );
  });
});

describe('考纲条目登记与审核闭环（存储）', () => {
  let root: string;
  let store: StudyStore;
  let materialId: string;

  const registerItem = (code: string, keys: string[]) =>
    store.createSyllabusItem({
      code,
      label: `条目 ${code}`,
      requirements: keys.map((key) => ({ key, text: `${key} 说明` })),
      source: { materialId, revision: 1, segmentId: 'S001' },
      recordScope: 'formal',
    });

  const proposeAndApprove = (name: string, mapping: { itemId: string; requirementKey: string } | null) => {
    const proposal = store.createProposal({
      projectId: 'proj-test',
      name,
      concept: `${name} 的完整陈述`,
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    return store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
      syllabus: mapping,
    });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-syllabus-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    store.createProject({ projectId: 'proj-test', displayName: '数学必修一', subject: '数学' });
    const imported = store.importMaterial({
      projectId: 'proj-test',
      displayName: '考纲.md',
      materialType: 'md',
      readableLocation: '考试范围',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。\n\n第三条范围说明。',
    });
    materialId = imported.material.materialId;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('登记条目会绑定可定位段落，编号重复与不可定位来源被拒绝', () => {
    const created = registerItem('K1-01', ['def', 'cond']);
    expect(created.source.fingerprint.length).toBe(64);
    expect(created.source.use).toBe('scope_basis');
    expect(created.source.sourceStale).toBe(false);

    expectCode(() => registerItem('k1-01', ['def']), 'SYLLABUS_CODE_DUPLICATE');
    expectCode(
      () =>
        store.createSyllabusItem({
          code: 'K1-02',
          label: '指向不存在的段落',
          requirements: [{ key: 'def', text: '说明' }],
          source: { materialId, revision: 1, segmentId: 'S999' },
          recordScope: 'formal',
        }),
      'SYLLABUS_SOURCE_NOT_LOCATABLE',
      'segment_not_found',
    );
    expectCode(
      () =>
        store.createSyllabusItem({
          code: 'K1-02',
          label: '没有必要要素',
          requirements: [],
          source: { materialId, revision: 1, segmentId: 'S001' },
          recordScope: 'formal',
        }),
      'INVALID_ARGUMENT',
      'empty_requirements',
    );
    expectCode(
      () =>
        store.createSyllabusItem({
          code: 'K1-02',
          label: '要素编号重复',
          requirements: [
            { key: 'def', text: '说明一' },
            { key: 'def', text: '说明二' },
          ],
          source: { materialId, revision: 1, segmentId: 'S001' },
          recordScope: 'formal',
        }),
      'INVALID_ARGUMENT',
      'duplicate_requirement_key',
    );
    expect(store.listSyllabusItems()).toHaveLength(1);
  });

  it('条目一经登记，未映射的「考纲内」候选不能批准，映射不落库', () => {
    const created = registerItem('K1-01', ['def']);
    expectCode(() => proposeAndApprove('增函数定义', null), 'SYLLABUS_ITEM_NOT_FOUND', 'mapping_required');
    expectCode(
      () => proposeAndApprove('增函数定义', { itemId: created.itemId, requirementKey: 'other' }),
      'SYLLABUS_REQUIREMENT_NOT_FOUND',
    );
    expect(store.listKnowledge()).toHaveLength(0);

    const outcome = proposeAndApprove('增函数定义', { itemId: created.itemId, requirementKey: 'def' });
    expect(outcome.knowledgePoint?.syllabusItemId).toBe(created.itemId);
    expect(outcome.knowledgePoint?.syllabusRequirementKey).toBe('def');
    expect(store.syllabusCoverage()).toMatchObject({
      totalItems: 1,
      coveredItems: 1,
      partialItems: 0,
      unmappedKnowledge: 0,
      coverageRate: 1,
    });
  });

  it('多个知识点映射同一要素仍只计一个条目；部分覆盖单独报告', () => {
    const created = registerItem('K1-01', ['def', 'cond']);
    proposeAndApprove('定义陈述', { itemId: created.itemId, requirementKey: 'def' });
    proposeAndApprove('定义的另一种表述', { itemId: created.itemId, requirementKey: 'def' });

    let coverage = store.syllabusCoverage();
    expect(coverage.items[0]).toMatchObject({ coveredRequirements: 1, totalRequirements: 2, state: 'partial' });
    expect(coverage.coveredItems).toBe(0);
    expect(coverage.partialItems).toBe(1);

    proposeAndApprove('适用条件陈述', { itemId: created.itemId, requirementKey: 'cond' });
    coverage = store.syllabusCoverage();
    expect(coverage).toMatchObject({ totalItems: 1, coveredItems: 1, partialItems: 0, coverageRate: 1 });
  });

  it('材料更新后条目按旧版本报告待核对，不静默改指新版本', () => {
    const created = registerItem('K1-01', ['def']);
    store.importMaterial({
      projectId: 'proj-test',
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义（修订）。',
    });
    const listed = store.listSyllabusItems().find((entry) => entry.itemId === created.itemId);
    expect(listed?.source.sourceStale).toBe(true);
    expect(listed?.source.revision).toBe(1);
  });
});
