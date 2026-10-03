import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSqliteDriver, projectPaths } from '@sew/study-storage';
import { closeProject, openProjectFromDisk } from '../apps/learning/lib/server/service';
import { ensureFixedLesson, loadRenderableDocument, reviewedLesson } from '../apps/learning/lib/server/classroom-service';
import { FIXED_MATERIAL } from '../apps/learning/lib/classroom/reviewed-lesson';
import { GET as getState } from '../apps/learning/app/api/maic/state/route';
import { POST as importDemo } from '../apps/learning/app/api/maic/demo/route';
import ClassroomPage from '../apps/learning/app/classroom/[id]/page';

describe('课堂读取与显式演示导入守卫', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sew-classroom-guard-')); });
  afterEach(() => {
    closeProject();
    const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } }).__sewSession;
    if (holder) holder.environmentBootstrapSuppressed = false;
    rmSync(root, { recursive: true, force: true });
  });

  it('只访问课堂页面不产生材料、候选、权威知识或题目', async () => {
    const session = openProjectFromDisk(root);
    await ClassroomPage({ params: Promise.resolve({ id: reviewedLesson.lessonId }) });
    expect(session.store.listMaterials()).toEqual([]);
    expect(session.store.listKnowledge()).toEqual([]);
    expect(session.store.listQuestions()).toEqual([]);
    expect(session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId)).toBeNull();
  });

  it('演示导入须明确确认且属于当前代次，合法导入可以读回', async () => {
    const session = openProjectFromDisk(root);
    const request = (body: unknown) => new Request('http://service.local/api/maic/demo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const scope = { projectId: session.projectId, generation: session.generation };
    expect((await importDemo(request({ scope }))).status).toBe(400);
    expect((await importDemo(request({ scope: { ...scope, generation: scope.generation + 1 }, confirmDemoImport: true }))).status).toBe(409);
    expect(session.store.listKnowledge()).toEqual([]);
    expect((await importDemo(request({ scope, confirmDemoImport: true }))).status).toBe(200);
    expect(loadRenderableDocument(session, reviewedLesson.stageId)?.sceneCount).toBe(3);
  });

  it('替换来源后拒绝文档与状态下发，保留历史文档', async () => {
    const session = openProjectFromDisk(root);
    ensureFixedLesson(session);
    session.store.importMaterial({
      projectId: session.projectId,
      ...FIXED_MATERIAL,
      rawText: `${FIXED_MATERIAL.rawText}\n\n已更新材料。`,
      recordScope: 'demo',
    });
    expect(() => loadRenderableDocument(session, reviewedLesson.stageId)).toThrowError(expect.objectContaining({ code: 'KNOWLEDGE_NOT_VERIFIED' }));
    const response = await getState(new Request(`http://service.local/api/maic/state?stageId=${reviewedLesson.stageId}`));
    expect(response.status).not.toBe(200);
    expect(session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId)).not.toBeNull();
  });

  it('存储内容被改写但digest列未变也不能下发', () => {
    const session = openProjectFromDisk(root);
    ensureFixedLesson(session);
    const driver = createNodeSqliteDriver();
    const database = driver.open(projectPaths(root).databaseFile);
    try {
      const modified = structuredClone(reviewedLesson.document);
      modified.stage.name = '未审核内容';
      database.prepare('UPDATE classroom_documents SET document_json = ? WHERE project_id = ?').run(JSON.stringify(modified), session.projectId);
    } finally { database.close(); }
    expect(() => loadRenderableDocument(session, reviewedLesson.stageId)).toThrowError(expect.objectContaining({ code: 'CLASSROOM_LESSON_NOT_REVIEWED' }));
  });

  it('来源绑定列损坏必须诊断拒绝，不能按空数组降级', () => {
    const session = openProjectFromDisk(root);
    ensureFixedLesson(session);
    const database = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    try {
      database.prepare("UPDATE classroom_scene_sources SET knowledge_ids_json = '[false]' WHERE project_id = ?").run(session.projectId);
    } finally { database.close(); }
    expect(() => loadRenderableDocument(session, reviewedLesson.stageId)).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
  });

  it.each([
    ['material', "UPDATE source_versions SET fingerprint = 'not-the-reviewed-material'"],
    ['knowledge', "UPDATE knowledge_points SET concept = '同名的其他定义'"],
    ['question', "UPDATE questions SET answer = 'A'"],
  ])('同名%s内容不符时不能作为登记演示记录复用', (_kind, sql) => {
    const session = openProjectFromDisk(root);
    ensureFixedLesson(session);
    const database = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    try { database.prepare(sql).run(); } finally { database.close(); }
    expect(() => ensureFixedLesson(session)).toThrowError(expect.objectContaining({ code: 'CLASSROOM_LESSON_NOT_REVIEWED' }));
  });

  it('测验侧表绑定另一条有效题目时不能下发或展示', () => {
    const session = openProjectFromDisk(root);
    const lesson = ensureFixedLesson(session);
    const knowledgeIds = lesson.bindings[0]!.knowledgeIds;
    const other = session.store.createQuestion({ stem: '另一道有效题目', answer: 'A', solution: '其他答案',
      knowledgeIds, requestedOrigin: 'ai_new', originRecord: null, recordScope: 'demo' }).question;
    const database = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    try {
      database.prepare("UPDATE classroom_scene_sources SET question_id = ? WHERE project_id = ? AND scene_id = 'scene-quiz-single'")
        .run(other.questionId, session.projectId);
    } finally { database.close(); }
    expect(() => loadRenderableDocument(session, lesson.stageId)).toThrowError(expect.objectContaining({ code: 'CLASSROOM_LESSON_NOT_REVIEWED' }));
    expect(session.store.listAttempts('real')).toEqual([]);
  });
});
