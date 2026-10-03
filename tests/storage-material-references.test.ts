import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@sew/study-contracts';
import {
  StudyStore,
  createNodeSqliteDriver,
  ensureProjectLayout,
  projectPaths,
} from '@sew/study-storage';

/**
 * F7：referencedByKnowledge 必须按最新 revision、精确解析 evidence JSON 计数，
 * 不能用 materialId 子串跨全部 revision 匹配（id 前缀重叠会多计）。
 */

const MATERIAL = [
  '# 函数性质',
  '',
  '函数 f 在区间 D 上单调递增，当 x1 < x2 时 f(x1) < f(x2)。',
  '',
  '证明时可以取值、作差、变形、定号并下结论。',
].join('\n');

describe('材料被知识点引用计数', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let materialId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-material-ref-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学' });
    const { material } = store.importMaterial({
      projectId,
      displayName: '函数.md',
      materialType: 'md',
      rawText: MATERIAL,
    });
    materialId = material.materialId;
    const proposal = store.createProposal({
      projectId,
      name: '单调递增',
      concept: 'x1 < x2 时 f(x1) < f(x2)',
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S002', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'ai',
    });
    store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const latestMaterial = () => {
    const found = store.listMaterials().find((m) => m.materialId === materialId);
    if (!found) throw new Error('材料不存在');
    return found;
  };

  it('getMaterial 不再固定 referenced:0', () => {
    expect(store.getMaterial(materialId, 1)?.referencedByKnowledge).toBe(1);
    expect(latestMaterial().referencedByKnowledge).toBe(1);
  });

  it('id 前缀重叠的其他材料不会被误计（精确匹配而非子串）', () => {
    store.close();
    const raw = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    raw
      .prepare(
        `INSERT INTO knowledge_points (knowledge_id, name, concept, conditions, source_status, scope_status, mastery_status, prerequisites_json, evidence_json, acceptance, priority, origin_proposal_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, '', 'verified', 'in_syllabus', 'untested', '[]', ?, '', 'medium', NULL, 0, ?, ?)`,
      )
      .run(
        'kp_prefix_overlap',
        '前缀重叠',
        '证据指向 id 更长的材料',
        JSON.stringify([
          { materialId: `${materialId}_suffix`, revision: 1, segmentId: 'S001', use: 'concept_basis' },
        ]),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    raw.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });

    expect(store.getMaterial(materialId, 1)?.referencedByKnowledge).toBe(1);
    expect(latestMaterial().referencedByKnowledge).toBe(1);
  });

  it('重新导入后只按最新 revision 计数，旧版本引用不计入当前版本', () => {
    store.importMaterial({
      projectId,
      displayName: '函数.md',
      materialType: 'md',
      rawText: `${MATERIAL}\n\n补充：最值与图像有关。`,
    });
    expect(latestMaterial().revision).toBe(2);
    expect(latestMaterial().referencedByKnowledge).toBe(0);
    expect(store.getMaterial(materialId, 1)?.referencedByKnowledge).toBe(1);
    expect(store.getMaterial(materialId, 2)?.referencedByKnowledge).toBe(0);
  });
});
