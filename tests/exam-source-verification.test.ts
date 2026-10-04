import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@sew/study-contracts';
import {
  closeProject, openProjectFromDisk, type Session,
} from '../apps/learning/lib/server/service';
import { POST as verifyExam } from '../apps/learning/app/api/study/materials/[materialId]/exam-verification/route';
import { GET as readMaterial } from '../apps/learning/app/api/study/materials/[materialId]/route';

/**
 * 真题出处人工核对入口（QUESTION-01）。
 *
 * 核实记录是服务端权威事实：只有这里的显式动作能写入，题目身份据此派生；
 * 请求方自称真题不会得到 exam_original，重复提交只更新同一条记录。
 */

const MATERIAL = '第 12 题：设函数 f(x) 在区间 D 上单调递增。\n\n解题要求：取值、作差、定号并下结论。';

describe('真题来源核对入口', () => {
  let session: Session;
  const roots: string[] = [];
  let materialId: string;

  const post = (body: Record<string, unknown>) => verifyExam(
    new Request('http://service.local/api/study/materials/x/exam-verification', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const scope = () => ({ projectId: session.projectId, generation: session.generation });

  const questionIdentity = () =>
    session.store.createQuestion({
      stem: '判断 f(x) 在 D 上的单调性',
      answer: '增函数',
      solution: '取值作差定号',
      knowledgeIds: [],
      requestedOrigin: 'exam_original',
      originRecord: { materialId, revision: 1, questionNumber: '12', rewrittenFrom: null, rewriteNote: '' },
    });

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'sew-exam-source-'));
    roots.push(root);
    session = openProjectFromDisk(root);
    const file = join(session.displayPath, 'paper.md');
    writeFileSync(file, MATERIAL, 'utf8');
    session.store.importMaterial({
      projectId: session.projectId,
      displayName: '试卷节选.md',
      materialType: 'md',
      readableLocation: '2023 年本市卷 12 题',
      rawText: MATERIAL,
    });
    materialId = session.store.listMaterials()[0]!.materialId;
  });

  afterEach(() => {
    closeProject();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('未核实时自称真题只得到材料原题，并留下伪装标记', () => {
    expect(session.store.listMaterials()[0]?.examVerification).toBeNull();
    const before = questionIdentity();
    expect(before.question.origin).toBe('material_original');
    expect(before.question.requestedOrigin).toBe('exam_original');
    expect(before.forgedExamClaim).toBe(true);
  });

  it('核对后同一请求派生为考试真题，且记录可在材料读取中看到', async () => {
    const response = await post({ scope: scope(), materialId, revision: 1, note: '与试卷原卷逐字比对' });
    expect(response.status).toBe(200);

    const detail = await readMaterial(
      new Request(`http://service.local/api/study/materials/${materialId}?revision=1`),
      { params: Promise.resolve({ materialId }) },
    );
    const { data } = await detail.json();
    expect(data.material.examVerification).toMatchObject({ note: '与试卷原卷逐字比对' });

    const after = session.store.createQuestion({
      stem: '判断 f(x) 在 D 上的单调性',
      answer: '增函数',
      solution: '取值作差定号',
      knowledgeIds: [],
      requestedOrigin: 'exam_original',
      originRecord: { materialId, revision: 1, questionNumber: '12', rewrittenFrom: null, rewriteNote: '' },
    });
    expect(after.question.origin).toBe('exam_original');
    expect(after.forgedExamClaim).toBe(false);
  });

  it('重复核对更新同一条记录而不是新增，旧版本仍单独判定', async () => {
    await post({ scope: scope(), materialId, revision: 1, note: '首次核对' });
    await post({ scope: scope(), materialId, revision: 1, note: '补充了出处页码' });
    expect(session.store.isMaterialVerifiedAsExam(materialId, 1)).toBe(true);

    const replaced = session.store.importMaterial({
      projectId: session.projectId,
      displayName: '试卷节选.md',
      materialType: 'md',
      rawText: `${MATERIAL}\n\n修订后的解题要求。`,
    });
    expect(replaced.material.revision).toBe(2);
    // 新版本没有被核对过：不能沿用旧版本的核实结论。
    expect(session.store.isMaterialVerifiedAsExam(materialId, 2)).toBe(false);
    expect(replaced.material.examVerification).toBeNull();
  });

  it('旧代次请求与不存在的材料版本都不能写入核实记录', async () => {
    const stale = await post({
      scope: { projectId: session.projectId, generation: session.generation + 1 },
      materialId,
      revision: 1,
      note: '',
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('PROJECT_GENERATION_STALE');

    const missing = await post({
      scope: scope(),
      materialId: newId<'material'>('mat'),
      revision: 1,
      note: '',
    });
    expect((await missing.json()).error.code).toBe('NOT_FOUND');
    expect(session.store.listMaterials()[0]?.examVerification).toBeNull();
  });
});
