/**
 * 考纲原子项与覆盖率（《规划书》8.1）。
 *
 * 覆盖率的分母是「人工登记的原子考纲条目」，不是知识点条数：
 * 一个条目内部的必要要素全部被覆盖才计入分子，部分覆盖另报；
 * 多个知识点映射到同一要素只计一次，「必要前置」知识点不增加分子。
 * 本模块只做判断，不读数据库，也不决定谁能进入统计。
 */

import { StudyError } from '@sew/study-contracts';
import type { RecordScope, ScopeStatus, SourceStatus } from '@sew/study-contracts';

export interface SyllabusRequirementRecord {
  key: string;
  text: string;
}

export interface SyllabusItemRecord {
  itemId: string;
  code: string;
  label: string;
  recordScope: RecordScope;
  requirements: SyllabusRequirementRecord[];
}

export interface SyllabusMappingRecord {
  itemId: string;
  requirementKey: string;
}

export interface SyllabusCoveragePointRecord {
  knowledgeId: string;
  scopeStatus: ScopeStatus;
  sourceStatus: SourceStatus;
  syllabusItemId: string | null;
  syllabusRequirementKey: string | null;
}

/**
 * 校验人工审核提交的考纲映射。
 *
 * 尚未登记任何考纲条目时允许空映射（此时只能报告为待映射缺口）；条目一经登记，
 * 「考纲内」候选必须映射到条目内的某个必要要素才能批准——《规划书》5.3 把考纲映射
 * 算作语义审核的一部分。一旦提交映射，就必须指向同一记录范围内真实存在的要素，
 * 且只有「考纲内」的知识点才能绑定条目。
 */
export const validateSyllabusMapping = (input: {
  scopeStatus: ScopeStatus;
  recordScope: RecordScope;
  mapping: SyllabusMappingRecord | null;
  item: SyllabusItemRecord | null;
  /** 该记录范围内是否已登记考纲条目。 */
  mappingRequired: boolean;
}): SyllabusMappingRecord | null => {
  if (input.mapping === null) {
    if (input.scopeStatus === 'in_syllabus' && input.mappingRequired) {
      throw new StudyError(
        'SYLLABUS_ITEM_NOT_FOUND',
        { reason: 'mapping_required' },
        '该候选标记为「考纲内」，需要先指定它覆盖哪个考纲条目的哪个必要要素',
      );
    }
    return null;
  }

  if (input.scopeStatus !== 'in_syllabus') {
    throw new StudyError('SYLLABUS_MAPPING_NOT_ALLOWED', { scopeStatus: input.scopeStatus });
  }
  if (!input.item) {
    throw new StudyError('SYLLABUS_ITEM_NOT_FOUND', { itemId: input.mapping.itemId });
  }
  if (input.item.recordScope !== input.recordScope) {
    throw new StudyError('SYLLABUS_ITEM_NOT_FOUND', {
      itemId: input.mapping.itemId,
      reason: 'record_scope_mismatch',
    });
  }
  if (!input.item.requirements.some((requirement) => requirement.key === input.mapping?.requirementKey)) {
    throw new StudyError('SYLLABUS_REQUIREMENT_NOT_FOUND', {
      itemId: input.mapping.itemId,
      requirementKey: input.mapping.requirementKey,
    });
  }
  return { itemId: input.mapping.itemId, requirementKey: input.mapping.requirementKey };
};

export interface SyllabusCoverageItemResult {
  itemId: string;
  code: string;
  label: string;
  totalRequirements: number;
  coveredRequirements: number;
  state: 'covered' | 'partial' | 'uncovered';
}

export interface SyllabusCoverageResult {
  totalItems: number;
  coveredItems: number;
  partialItems: number;
  uncoveredItems: number;
  coverageRate: number | null;
  unmappedKnowledge: number;
  items: SyllabusCoverageItemResult[];
}

/**
 * 计算考纲覆盖。
 *
 * 只有「已核实 + 通过准入 + 考纲内」的知识点才算覆盖某个必要要素；
 * 材料缺失或未准入的知识点保留在分母里，作为缺口单独报告。
 */
export const computeSyllabusCoverage = (input: {
  items: readonly SyllabusItemRecord[];
  points: readonly SyllabusCoveragePointRecord[];
  /** `checkAdmission` 判定可进入教学的知识点集合。 */
  admittedIds: ReadonlySet<string>;
}): SyllabusCoverageResult => {
  const counted = new Map<string, Set<string>>();
  for (const point of input.points) {
    if (point.sourceStatus !== 'verified') continue;
    if (point.scopeStatus !== 'in_syllabus') continue;
    if (!input.admittedIds.has(point.knowledgeId)) continue;
    if (point.syllabusItemId === null || point.syllabusRequirementKey === null) continue;
    const bucket = counted.get(point.syllabusItemId) ?? new Set<string>();
    bucket.add(point.syllabusRequirementKey);
    counted.set(point.syllabusItemId, bucket);
  }

  const unmappedKnowledge = input.points.filter(
    (point) =>
      point.sourceStatus === 'verified' &&
      point.scopeStatus === 'in_syllabus' &&
      input.admittedIds.has(point.knowledgeId) &&
      (point.syllabusItemId === null || point.syllabusRequirementKey === null),
  ).length;

  const items: SyllabusCoverageItemResult[] = [];
  let coveredItems = 0;
  let partialItems = 0;
  let uncoveredItems = 0;
  for (const item of input.items) {
    const hit = counted.get(item.itemId) ?? new Set<string>();
    const coveredRequirements = item.requirements.filter((requirement) => hit.has(requirement.key)).length;
    const totalRequirements = item.requirements.length;
    const state = coveredRequirements === 0 ? 'uncovered' : coveredRequirements < totalRequirements ? 'partial' : 'covered';
    if (state === 'covered') coveredItems += 1;
    else if (state === 'partial') partialItems += 1;
    else uncoveredItems += 1;
    items.push({
      itemId: item.itemId,
      code: item.code,
      label: item.label,
      totalRequirements,
      coveredRequirements,
      state,
    });
  }

  return {
    totalItems: input.items.length,
    coveredItems,
    partialItems,
    uncoveredItems,
    coverageRate: input.items.length === 0 ? null : coveredItems / input.items.length,
    unmappedKnowledge,
    items: items.sort((left, right) => left.code.localeCompare(right.code)),
  };
};
