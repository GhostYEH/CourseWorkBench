import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENE_INTERACTIVE_ID, SCENE_QUIZ_ID } from '../apps/learning/lib/classroom/reviewed-lesson';
import { POST as postAttempt } from '../apps/learning/app/api/study/attempts/route';
import { GET as getState, PUT as putState } from '../apps/learning/app/api/maic/state/route';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { ensureFixedLesson, loadRenderableDocument } from '../apps/learning/lib/server/classroom-service';
import { apiResponses } from '@sew/study-contracts';

/**
 * 真实课堂本人提交与重启读回（STORE-01）。
 *
 * 走的是页面实际调用的处理函数：课堂状态写 SQLite、测验提交交给服务判分，
 * 然后关闭项目再重新打开，验证读回的是同一份记录。
 */

const json = (value: unknown): string => JSON.stringify(value);

const envelope = <T,>(response: Response, body: T): T => {
  expect(response.status).toBe(200);
  return body;
};

describe('真实课堂提交与重启读回', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-readback-'));
  });

  afterEach(() => {
    closeProject();
    // 见 classroom-document-store：还原环境引导抑制标记，避免污染同 worker 的后续套件。
    const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } }).__sewSession;
    if (holder) holder.environmentBootstrapSuppressed = false;
    rmSync(root, { recursive: true, force: true });
  });

  const submit = async (
    session: Session,
    input: { questionId: string; idempotencyKey: string; answerText: string; actorType: string; kind: string },
  ): Promise<Response> =>
    postAttempt(
      new Request('http://service.local/api/study/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json({
          scope: { projectId: session.projectId, generation: session.generation },
          questionId: input.questionId,
          idempotencyKey: input.idempotencyKey,
          actorType: input.actorType,
          answerText: input.answerText,
          processText: '取值、作差、定号',
          kind: input.kind,
        }),
      }),
    );

  it('本人提交经服务判分并写入 SQLite，重启后读回同一条记录', async () => {
    let session = openProjectFromDisk(root);
    const ensured = ensureFixedLesson(session);
    const questionId = ensured.bindings.find((binding) => binding.sceneId === SCENE_QUIZ_ID)?.questionId;
    expect(questionId).toBeTruthy();

    const wrong = await submit(session, {
      questionId: questionId ?? '',
      idempotencyKey: 'kb-wrong-1',
      answerText: 'D',
      actorType: 'human_learner',
      kind: 'real',
    });
    const wrongBody = envelope(wrong, await wrong.json() as {
      data: { attempt: { kind: string; masteryAfter: string | null }; deduplicated: boolean };
    });
    // 判分由服务完成：选项 D 听起来合理但不符合定义，不能由浏览器自报为掌握。
    expect(wrongBody.data.attempt.kind).toBe('real');
    expect(wrongBody.data.attempt.masteryAfter).toBeNull();

    const right = await submit(session, {
      questionId: questionId ?? '',
      idempotencyKey: 'kb-right-1',
      answerText: 'B',
      actorType: 'human_learner',
      kind: 'real',
    });
    const rightBody = envelope(right, await right.json() as {
      data: { attempt: { kind: string; masteryAfter: string | null } };
    });
    expect(rightBody.data.attempt.masteryAfter).toBeNull();

    // 场景位置也写在 SQLite 里。
    const put = await putState(
      new Request('http://service.local/api/maic/state', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: json({
          scope: { projectId: session.projectId, generation: session.generation },
          stageId: ensured.stageId,
          sceneId: SCENE_INTERACTIVE_ID,
        }),
      }),
    );
    expect(put.status).toBe(200);
    expect(apiResponses.classroomPosition.safeParse((await put.json()).data).success).toBe(true);

    // —— 模拟重启：关闭项目再重新打开同一目录 ——
    closeProject();
    session = openProjectFromDisk(root);

    const attempts = session.store.listAttempts('real', 'demo');
    expect(attempts.map((attempt) => attempt.answerText).sort()).toEqual(['B', 'D']);
    expect(attempts.every((attempt) => attempt.questionId === questionId)).toBe(true);
    expect(session.store.getKnowledge(ensured.bindings[0]!.knowledgeIds[0]!, 'demo')?.masteryStatus).toBe('untested');
    expect(session.store.countAttemptKinds()).toEqual({ real: 0, simulation: 0 });

    const state = await getState(
      new Request(`http://service.local/api/maic/state?stageId=${ensured.stageId}`),
    );
    const stateBody = await state.json() as {
      data: { currentSceneId: string; revision: number; bindings: Array<{ sceneId: string }> };
    };
    expect(stateBody.data.currentSceneId).toBe(SCENE_INTERACTIVE_ID);
    expect(stateBody.data.revision).toBeGreaterThan(0);
    expect(stateBody.data.bindings.map((binding) => binding.sceneId)).toContain(SCENE_QUIZ_ID);

    // 重启后渲染文档依然不含答案。
    const renderable = loadRenderableDocument(session, ensured.stageId);
    expect(JSON.stringify(renderable?.document)).not.toContain('"answer"');
  });

  it('同一提交内容重试读取既有收据，不重复计数', async () => {
    const session = openProjectFromDisk(root);
    const ensured = ensureFixedLesson(session);
    const questionId = ensured.bindings.find((binding) => binding.sceneId === SCENE_QUIZ_ID)?.questionId ?? '';

    const first = await submit(session, {
      questionId,
      idempotencyKey: 'kb-duplicate-1',
      answerText: 'B',
      actorType: 'human_learner',
      kind: 'real',
    });
    await first.json();
    const second = await submit(session, {
      questionId,
      idempotencyKey: 'kb-duplicate-1',
      answerText: 'B',
      actorType: 'human_learner',
      kind: 'real',
    });
    const secondBody = await second.json() as { data: { deduplicated: boolean } };
    expect(secondBody.data.deduplicated).toBe(true);
    expect(session.store.listAttempts('real', 'demo')).toHaveLength(1);
  });

  it('AI 同学的提交只进 simulation 分区，不改本人记录', async () => {
    const session = openProjectFromDisk(root);
    const ensured = ensureFixedLesson(session);
    const questionId = ensured.bindings.find((binding) => binding.sceneId === SCENE_QUIZ_ID)?.questionId ?? '';

    const response = await submit(session, {
      questionId,
      idempotencyKey: 'kb-peer-ai-1',
      answerText: 'B',
      actorType: 'peer_ai',
      kind: 'real',
    });
    const body = await response.json() as { data: { attempt: { kind: string }; forcedSimulation: boolean } };
    expect(body.data.attempt.kind).toBe('simulation');
    expect(body.data.forcedSimulation).toBe(true);
    expect(session.store.listAttempts('real', 'demo')).toHaveLength(0);
    expect(session.store.listAttempts('simulation', 'demo')).toHaveLength(1);
    expect(session.store.getKnowledge(ensured.bindings[0]!.knowledgeIds[0]!, 'demo')?.masteryStatus).toBe('untested');
  });

  it('旧代次的课堂状态写入被拒绝，不能污染当前项目', async () => {
    const session = openProjectFromDisk(root);
    const ensured = ensureFixedLesson(session);
    const staleGeneration = session.generation + 1;

    const response = await putState(
      new Request('http://service.local/api/maic/state', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: json({
          scope: { projectId: session.projectId, generation: staleGeneration },
          stageId: ensured.stageId,
          sceneId: SCENE_INTERACTIVE_ID,
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(session.store.readClassroomState(session.projectId, ensured.stageId)).toBeNull();
  });

  it('课堂状态只接受文档里真实存在的场景', async () => {
    const session = openProjectFromDisk(root);
    const ensured = ensureFixedLesson(session);

    const response = await putState(
      new Request('http://service.local/api/maic/state', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: json({
          scope: { projectId: session.projectId, generation: session.generation },
          stageId: ensured.stageId,
          sceneId: 'scene-invented',
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(session.store.readClassroomState(session.projectId, ensured.stageId)).toBeNull();
  });
});
