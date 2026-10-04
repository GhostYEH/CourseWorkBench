import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StudyError,
  apiResponses,
  type ModelChatMessage,
  type ModelGenerationInput,
  type PlanPayloadDto,
} from '@sew/study-contracts';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import {
  attachFormalLessonDocument,
  loadRenderableDocument,
  loadRenderableFormalDocument,
} from '../apps/learning/lib/server/classroom-service';
import { generateGuarded } from '../apps/learning/lib/server/model-call';
import { formalStageId } from '../apps/learning/lib/classroom/formal-lesson-document';
import ClassroomPage from '../apps/learning/app/classroom/[id]/page';
import { ClassroomSurface } from '../apps/learning/components/classroom-surface';
import { POST as lessonPost } from '../apps/learning/app/api/study/lessons/route';
import { POST as classroomPost } from '../apps/learning/app/api/study/classroom/route';

/**
 * 正式课件文档生成与课堂挂接（LESSON-02 / M2-D）。
 *
 * 固定的是可自证的那部分：文档只由该版本冻结的证据包装配，挂接要同时满足
 * 「本版本已审核」+「本版本正在发布」，课堂读取按指纹与准入复验，
 * 撤回、来源失效或文档被改写都只能得到明确的阻断，不能降级成「按旧内容继续上」。
 * 真实 provider 下的整节课验收不在本文件范围内。
 */

const expectCode = (action: () => unknown, code: string, reason?: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    if (reason !== undefined) expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

/** 只沿 props.children 取文案：组件引用本身带循环结构，不能整体序列化。 */
const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object') {
    const children = (node as { props?: { children?: unknown } }).props?.children;
    return children === undefined ? '' : textOf(children);
  }
  return '';
};

describe('正式课件文档与课堂挂接', () => {
  let root: string;
  let session: Session;
  let projectId: string;
  let knowledgeId: string;
  let otherKnowledgeId: string;
  let bundleId = '';
  let statementIds: string[] = [];
  let lessonId = '';
  let lessonVersion = 1;

  const buildLesson = (questionIds: string[] = []): { lessonId: string; version: number } => {
    const bundle = session.store.buildLessonBundle(
      projectId,
      [
        { knowledgeId, text: '增函数的定义：在区间 D 内任取 x1 < x2 都有 f(x1) < f(x2)', conditions: '同一区间 D 内' },
        { knowledgeId: otherKnowledgeId, text: '判断步骤：取值、作差、变形、定号、下结论', conditions: '' },
      ],
      questionIds,
    );
    bundleId = bundle.bundleId;
    statementIds = bundle.bundle.statements.map((statement) => statement.statementId);
    const lesson = session.store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性（第 1 课时）',
      bundleId,
      statementIds,
      questionIds,
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
    return { lessonId, version: lessonVersion };
  };

  const reviewAndPublish = (): void => {
    session.store.reviewLesson({
      projectId, lessonId, version: lessonVersion, decision: 'approved', note: '按原文核对两份陈述',
    });
    session.store.publishLesson({ projectId, lessonId, version: lessonVersion });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-formal-doc-'));
    session = openProjectFromDisk(root);
    projectId = session.projectId;
    const imported = session.store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n判断单调性的基本步骤是取值、作差、变形、定号、下结论。',
    });
    const materialId = imported.material.materialId;
    const makeKnowledge = (name: string, concept: string, segmentId: string): string => {
      const proposal = session.store.createProposal({
        projectId,
        name,
        concept,
        conditions: '同一区间内',
        scopeStatus: 'in_syllabus',
        prerequisites: [],
        evidence: [{ materialId, revision: 1, segmentId, use: 'concept_basis' }],
        acceptance: '',
        priority: 'medium',
        proposedBy: 'user',
      });
      return session.store.applyReview({
        proposalId: proposal.proposalId,
        decision: 'approved',
        expectedRevision: proposal.revision,
        semanticReviewed: true,
      }).knowledgePoint!.knowledgeId;
    };
    knowledgeId = makeKnowledge('增函数定义', '区间内任取 x1 < x2 都有 f(x1) < f(x2)', 'S001');
    otherKnowledgeId = makeKnowledge('单调性判断步骤', '取值、作差、变形、定号、下结论', 'S002');
    session.store.savePlanVersion(projectId, 1, 'confirmed', {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        { knowledgeId, name: '增函数定义', minutes: 30, acceptance: '', evidence: [{ materialId, segmentId: 'S001' }] },
        { knowledgeId: otherKnowledgeId, name: '判断步骤', minutes: 20, acceptance: '', evidence: [{ materialId, segmentId: 'S002' }] },
      ],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId, otherKnowledgeId],
    } satisfies PlanPayloadDto);
    buildLesson();
  });

  afterEach(() => {
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });

  it('挂接后的文档每个冻结陈述一个场景，并按证据包绑定来源', () => {
    reviewAndPublish();
    const info = attachFormalLessonDocument(session, lessonId, lessonVersion);
    expect(info.stageId).toBe(formalStageId(lessonId, lessonVersion));
    expect(info.scenes).toHaveLength(2);
    expect(info.scenes.every((scene) => scene.sceneType === 'slide')).toBe(true);
    expect(info.skipped).toEqual([]);
    expect(info.attached).toBe(true);

    const renderable = loadRenderableFormalDocument(session, lessonId);
    expect(renderable).not.toBeNull();
    expect(renderable!.digest).toBe(info.digest);
    const json = JSON.stringify(renderable!.document);
    // 场景里带来源定位，师生在课堂上就能看到这句话出自哪一段。
    expect(json).toContain('来源：');
    expect(json).toContain('增函数的定义');
    expect(session.store.getLessonClassroomLink(lessonId, projectId)).toMatchObject({
      stageId: info.stageId,
      documentDigest: renderable!.digest,
      status: 'published',
    });
  });

  it('挂接要求本版本已审核通过且正在发布：草案未发布拒绝，审核改判后同样拒绝', () => {
    expectCode(
      () => attachFormalLessonDocument(session, lessonId, lessonVersion),
      'STEP_ALREADY_COMMITTED',
      'lesson_not_currently_published',
    );
    session.store.reviewLesson({ projectId, lessonId, version: lessonVersion, decision: 'approved', note: '' });
    expectCode(
      () => attachFormalLessonDocument(session, lessonId, lessonVersion),
      'STEP_ALREADY_COMMITTED',
      'lesson_not_currently_published',
    );
    session.store.publishLesson({ projectId, lessonId, version: lessonVersion });
    expect(attachFormalLessonDocument(session, lessonId, lessonVersion).attached).toBe(true);

    // 新版本发布后，旧版本不再是被挂接的对象：它的文档留在库里但课堂映射已移走。
    const next = session.store.createLessonDraft({
      projectId, lessonId, title: '函数单调性（第 1 课时·修订）', bundleId, statementIds, questionIds: [],
    });
    session.store.reviewLesson({ projectId, lessonId, version: next.version, decision: 'approved', note: '复核通过' });
    session.store.publishLesson({ projectId, lessonId, version: next.version });
    expectCode(
      () => attachFormalLessonDocument(session, lessonId, lessonVersion),
      'STEP_ALREADY_COMMITTED',
      'lesson_not_currently_published',
    );
    expect(attachFormalLessonDocument(session, lessonId, next.version).attached).toBe(true);
  });

  it('重复挂接幂等：同一指纹不产生第二份文档', () => {
    reviewAndPublish();
    const first = attachFormalLessonDocument(session, lessonId, lessonVersion);
    const second = attachFormalLessonDocument(session, lessonId, lessonVersion);
    expect(second.reused).toBe(true);
    expect(second.digest).toBe(first.digest);
    expect(session.store.listClassroomDocuments(projectId).filter((row) => row.stageId === first.stageId)).toHaveLength(1);
  });

  it('撤回或被新版本取代后，课堂读取按发布映射阻断', () => {
    reviewAndPublish();
    attachFormalLessonDocument(session, lessonId, lessonVersion);
    expect(loadRenderableFormalDocument(session, lessonId)).not.toBeNull();
    session.store.withdrawLesson({ projectId, lessonId, reason: '教师停用' });
    expectCode(() => loadRenderableFormalDocument(session, lessonId), 'CLASSROOM_LESSON_NOT_REVIEWED', 'no_published_link');
  });

  it('冻结之后来源更新时，课堂读取按准入阻断而不是照旧授课', () => {
    reviewAndPublish();
    attachFormalLessonDocument(session, lessonId, lessonVersion);
    session.store.importMaterial({
      projectId, displayName: '考纲.md', materialType: 'md', rawText: '原文已被替换，旧段落不再可用。',
    });
    // 阻断的具体码按准入实现给出，这里只固定「必须阻断」这一件事。
    try {
      loadRenderableFormalDocument(session, lessonId);
    } catch (error) {
      expect(['KNOWLEDGE_INVALIDATED', 'KNOWLEDGE_NOT_VERIFIED', 'SOURCE_REVISION_STALE'])
        .toContain((error as StudyError).code);
      return;
    }
    throw new Error('来源已失效却仍然读到了课堂文档');
  });

  it('文档被改写后按指纹拒绝：映射里的旧摘要不能放行新内容', () => {
    reviewAndPublish();
    const info = attachFormalLessonDocument(session, lessonId, lessonVersion);
    const stored = session.store.getClassroomDocument(projectId, info.stageId)!;
    const scenes = (stored.document as { scenes: Array<Record<string, unknown>> }).scenes;
    const tampered = session.store.putClassroomScene(
      projectId,
      info.stageId,
      { ...scenes[0]!, title: '被改写过的场景标题', content: { type: 'slide', schemaVersion: 1, canvas: { ...(scenes[0]!.content as { canvas: Record<string, unknown> }).canvas } } },
      stored.digest,
    );
    expect(tampered).toBe(true);
    expectCode(() => loadRenderableFormalDocument(session, lessonId), 'VERSION_CONFLICT', 'formal_digest_mismatch');
  });

  it('来源失效后的组装失败不写文档或课堂挂接', () => {
    reviewAndPublish();
    session.store.importMaterial({ projectId, displayName: '考纲.md', materialType: 'md', rawText: '替换后的来源' });
    expect(() => attachFormalLessonDocument(session, lessonId, lessonVersion)).toThrow();
    expect(session.store.getClassroomDocument(projectId, formalStageId(lessonId, lessonVersion))).toBeNull();
    expect(session.store.getLessonClassroomLink(lessonId, projectId)!.stageId).toBeNull();
  });

  it('题目未登记题型时不生成假测验：题目按跳过项说明，课堂仍只有幻灯片', () => {
    const question = session.store.createQuestion({
      stem: '按定义判断增函数应满足哪一项？',
      answer: 'B',
      solution: '定义要求 x1 < x2 时都有 f(x1) < f(x2)。',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'ai_new',
      originRecord: null,
    });
    buildLesson([question.question.questionId]);
    reviewAndPublish();
    const info = attachFormalLessonDocument(session, lessonId, lessonVersion);
    const questionSkipped = info.skipped.filter((item) => item.kind === 'question');
    expect(questionSkipped).toHaveLength(1);
    expect(questionSkipped[0]!.reason).toContain('测验场景');
    expect(info.scenes.every((scene) => scene.sceneType === 'slide')).toBe(true);
    expect(loadRenderableFormalDocument(session, lessonId)!.sceneCount).toBe(info.sceneCount);
  });

  it('课堂页面按课时读取正式文档并挂接教师会话，演示页与未挂接页各自给出明确状态', async () => {
    reviewAndPublish();
    // 已发布但未挂接：页面提示生成文档，不落空白。
    const pending = await ClassroomPage({ params: Promise.resolve({ id: lessonId }) });
    expect(textOf(pending)).toContain('还没有生成课件文档');

    const info = attachFormalLessonDocument(session, lessonId, lessonVersion);
    const page = await ClassroomPage({ params: Promise.resolve({ id: lessonId }) }) as unknown as {
      type: unknown;
      props: {
        lessonId: string;
        stageId: string;
        recordScope: string;
        teacher: { lessonVersion: number; stageId: string };
        bindings: Array<{ knowledgeIds: string[]; sceneType: string }>;
      };
    };
    expect(page.type).toBe(ClassroomSurface);
    expect(page.props).toMatchObject({
      lessonId,
      stageId: info.stageId,
      recordScope: 'formal',
      teacher: { lessonVersion, stageId: info.stageId },
    });
    expect(page.props.bindings).toHaveLength(2);
    expect(page.props.bindings[0]!.knowledgeIds.length).toBeGreaterThan(0);
  });

  it('课程接口只接受版本编号：文档摘要由服务端算出并受响应合同约束', async () => {
    reviewAndPublish();
    const response = await lessonPost(new Request('http://service.local/api/study/lessons', {
      method: 'POST',
      body: JSON.stringify({
        scope: { projectId, generation: session.generation },
        action: 'attach-document',
        lessonId,
        version: lessonVersion,
      }),
    }));
    const envelope = await response.json();
    expect(envelope.ok).toBe(true);
    const parsed = apiResponses.lessonDocument.safeParse(envelope.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const document = parsed.data.document;
    expect(document.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(document.attached).toBe(true);
    expect(document.scenes.map((scene) => scene.sceneId))
      .toEqual(expect.arrayContaining([expect.stringContaining('scene_slide_stmt_')]));
  });

  it('统一读取入口按记录范围分派：演示文档仍走固定指纹守卫，正式文档不套用', () => {
    reviewAndPublish();
    const info = attachFormalLessonDocument(session, lessonId, lessonVersion);
    expect(loadRenderableDocument(session, info.stageId)?.stageId).toBe(info.stageId);
    expect(loadRenderableDocument(session, 'stage-not-here')).toBeNull();
  });

  /** 假 provider：只记录 AbortSignal 并在被中止时返回，用来证明请求真的可中止。 */
  const slowProvider = (): {
    signals: Array<AbortSignal | undefined>;
    runtime: {
      status: () => { configured: boolean; persisted: boolean; lastTest: null };
      generate: (messages: ModelChatMessage[], options?: { maxTokens?: number; signal?: AbortSignal }) => Promise<{
        dispatched: boolean; ok: boolean; message: string; text: string | null;
        totalTokens: number; requestedModel: null; elapsedMs: number;
      }>;
    };
  } => {
    const signals: Array<AbortSignal | undefined> = [];
    const runtime = {
      status: () => ({ configured: true, persisted: false, lastTest: null }),
      generate: (_messages: ModelChatMessage[], options?: { maxTokens?: number; signal?: AbortSignal }) => new Promise<{
        dispatched: boolean; ok: boolean; message: string; text: string | null;
        totalTokens: number; requestedModel: null; elapsedMs: number;
      }>((resolve) => {
        signals.push(options?.signal);
        options?.signal?.addEventListener('abort', () => resolve({
          dispatched: true, ok: false, message: '生成已取消', text: null, totalTokens: 12, requestedModel: null, elapsedMs: 1,
        }), { once: true });
      }),
    };
    return { signals, runtime };
  };

  it('取消课堂时真正中止正在执行的 provider 请求，而不是等它返回再丢弃', async () => {
    reviewAndPublish();
    const info = attachFormalLessonDocument(session, lessonId, lessonVersion);
    session.store.startPlanRun(projectId);
    const runId = session.store.getLatestRun()!.runId;
    const sceneId = info.scenes[0]!.sceneId;

    const request = (body: Record<string, unknown>): Request => new Request('http://service.local/api/study/classroom', {
      method: 'POST',
      body: JSON.stringify({ scope: { projectId, generation: session.generation }, ...body }),
    });

    const opened = await classroomPost(request({ action: 'open', lessonId, stageId: info.stageId, sceneId }));
    const sessionId = (await opened.json()).data.session.sessionId as string;

    const provider = slowProvider();
    const pending = generateGuarded(
      { store: session.store, projectId, connection: provider.runtime },
      {
        scope: { projectId, generation: session.generation },
        purpose: 'teaching_prompt',
        bundleId,
        lessonId,
        instruction: '给这一条陈述补一句课堂提问',
      } satisfies ModelGenerationInput,
    );
    // 请求确实带上了可中止的信号，而不是「发出去就只能等回包」。
    expect(provider.signals).toHaveLength(1);
    expect(provider.signals[0]?.aborted).toBe(false);

    const closed = await classroomPost(request({ action: 'close', sessionId, status: 'cancelled', reason: '教师中断' }));
    const closedBody = await closed.json();
    expect(closedBody.ok).toBe(true);
    expect(closedBody.data.abortedCalls).toBe(1);
    expect(provider.signals[0]?.aborted).toBe(true);

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.pendingExplanationId).toBeNull();
    expect(session.store.listExplanationCards(lessonId, lessonVersion, projectId)).toHaveLength(0);
    // 已发出的调用仍然计入台账与预算，取消不能变成免费重试。
    expect(session.store.modelCallUsage(runId).calls).toBe(1);
  });

  it('交还本人与撤回课程同样中止在途请求', async () => {
    reviewAndPublish();
    const info = attachFormalLessonDocument(session, lessonId, lessonVersion);
    session.store.startPlanRun(projectId);

    const classroomRequest = (body: Record<string, unknown>): Request => new Request('http://service.local/api/study/classroom', {
      method: 'POST',
      body: JSON.stringify({ scope: { projectId, generation: session.generation }, ...body }),
    });
    const opened = await classroomPost(classroomRequest({ action: 'open', lessonId, stageId: info.stageId, sceneId: info.scenes[0]!.sceneId }));
    const sessionId = (await opened.json()).data.session.sessionId as string;

    const handback = slowProvider();
    const pendingTeaching = generateGuarded(
      { store: session.store, projectId, connection: handback.runtime },
      {
        scope: { projectId, generation: session.generation },
        purpose: 'teaching_prompt',
        bundleId,
        lessonId,
        instruction: '先给图像直觉',
      } satisfies ModelGenerationInput,
    );
    const handed = await classroomPost(classroomRequest({ action: 'handback', sessionId, reason: '本人作答' }));
    expect((await handed.json()).data.abortedCalls).toBe(1);
    expect(handback.signals[0]?.aborted).toBe(true);
    expect((await pendingTeaching).ok).toBe(false);
    expect(session.store.getClassroomSession(sessionId, projectId)!.status).toBe('awaiting_learner');

    // 课程撤回后，任何仍在途的本项目调用都不该继续。
    const draft = slowProvider();
    const pendingDraft = generateGuarded(
      { store: session.store, projectId, connection: draft.runtime },
      {
        scope: { projectId, generation: session.generation },
        purpose: 'lesson_draft',
        bundleId,
        lessonId: null,
        instruction: '按这份证据包起草本节要点',
      } satisfies ModelGenerationInput,
    );
    const withdrawn = await lessonPost(new Request('http://service.local/api/study/lessons', {
      method: 'POST',
      body: JSON.stringify({
        scope: { projectId, generation: session.generation }, action: 'withdraw', lessonId, reason: '教师停用',
      }),
    }));
    expect((await withdrawn.json()).ok).toBe(true);
    expect(draft.signals[0]?.aborted).toBe(true);
    expect((await pendingDraft).ok).toBe(false);
  });
});
