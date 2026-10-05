import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses, newId, type PlanPayloadDto } from '@sew/study-contracts';
import { POST as lessonsPost } from '../apps/learning/app/api/study/lessons/route';
import { POST as revisionPost } from '../apps/learning/app/api/study/lessons/revision/route';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';

/**
 * 课程命令的 HTTP 边界（LESSON-02）：草案派生与陈述改写处置都按 requestId 幂等。
 *
 * 固定三件事：① 相同 requestId 与意图重试返回既有版本/候选，不追加第二个版本；
 * ② 相同 requestId 但意图不同按 nonce 复用拒绝；③ 响应通过运行时合同校验。
 */

describe('课程命令 HTTP 幂等边界', () => {
  let root: string;
  let session: Session;
  let bundleId = '';
  let statementId = '';
  let lessonId = '';
  let lessonVersion = 1;
  const scope = () => ({ projectId: session.projectId, generation: session.generation });

  const post = (body: Record<string, unknown>) =>
    lessonsPost(
      new Request('http://127.0.0.1/api/study/lessons', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scope(), ...body }),
      }),
    );

  const proposeRevision = (body: Record<string, unknown>) =>
    revisionPost(
      new Request('http://127.0.0.1/api/study/lessons/revision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scope(), action: 'propose-statement-revision', ...body }),
      }),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-lesson-revision-http-'));
    session = openProjectFromDisk(root);
    const projectId = session.projectId;
    const imported = session.store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    const proposal = session.store.createProposal({
      projectId,
      name: '增函数定义',
      concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [
        {
          materialId: imported.material.materialId,
          revision: 1,
          segmentId: imported.segments[0]!.segmentId,
          use: 'concept_basis',
        },
      ],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    const knowledgeId = session.store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    const payload: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数定义',
          minutes: 30,
          acceptance: '',
          evidence: [
            {
              materialId: imported.material.materialId,
              segmentId: imported.segments[0]!.segmentId,
            },
          ],
        },
      ],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    session.store.savePlanVersion(projectId, 1, 'confirmed', payload);
    session.store.startPlanRun(projectId);
    const bundle = session.store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }],
      [],
    );
    bundleId = bundle.bundleId;
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = session.store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性',
      bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
  });

  afterEach(() => {
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });

  it('带 requestId 的草案派生按意图幂等，响应通过合同校验', async () => {
    const draftBody = {
      action: 'draft',
      requestId: 'draft-fixed-1',
      lessonId,
      bundleId,
      title: '函数单调性（改写）',
      statementIds: [statementId],
      questionIds: [],
    };
    const first = await post(draftBody);
    expect(first.status).toBe(200);
    const firstData = (await first.json()).data;
    expect(apiResponses.lessonDraft.safeParse(firstData).success).toBe(true);
    expect(firstData.lesson.version).toBe(lessonVersion + 1);

    const second = await post(draftBody);
    const secondData = (await second.json()).data;
    expect(secondData.lesson.version).toBe(lessonVersion + 1);
    expect(session.store.listLessonVersions(lessonId, session.projectId)).toHaveLength(
      lessonVersion + 1,
    );

    const conflicting = await post({ ...draftBody, title: '另一个标题' });
    expect(conflicting.status).toBe(409);
  });

  it('陈述改写处置按 requestId 幂等：通过派生新版本，重试不追加', async () => {
    const candidate = session.store.createStatementRevision({
      candidateId: newId<'rev'>('rev'),
      projectId: session.projectId,
      lessonId,
      baseVersion: lessonVersion,
      statementId,
      knowledgeId: session.store.getEvidenceBundle(session.projectId, bundleId)!.bundle
        .statements[0]!.knowledgeId,
      proposedText: '若对区间 D 内任意 x1 < x2 都有 f(x1) < f(x2)，则称 f 在 D 上单调递增。',
      proposedConditions: '同一区间 D 内',
      evidence: session.store.getEvidenceBundle(session.projectId, bundleId)!.bundle.statements[0]!
        .evidence,
      instruction: '更完整',
    });
    const applyBody = {
      action: 'apply-statement-revision',
      requestId: 'apply-fixed-1',
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '与教材一致',
    };
    const first = await post(applyBody);
    expect(first.status).toBe(200);
    const firstData = (await first.json()).data;
    expect(apiResponses.lessonRevisionApply.safeParse(firstData).success).toBe(true);
    expect(firstData.lesson.version).toBe(lessonVersion + 1);
    expect(firstData.candidate.status).toBe('applied');

    const second = await post(applyBody);
    const secondData = (await second.json()).data;
    expect(secondData.deduplicated).toBe(true);
    expect(secondData.lesson.version).toBe(lessonVersion + 1);
    expect(session.store.listLessonVersions(lessonId, session.projectId)).toHaveLength(
      lessonVersion + 1,
    );
  });

  it('未配置模型时候选生成返回明确错误，不发 provider 请求', async () => {
    const response = await proposeRevision({
      requestId: 'propose-fixed-1',
      lessonId,
      version: lessonVersion,
      statementId,
      instruction: '更口语',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'MODEL_NOT_CONFIGURED',
    );
    expect(session.store.listProjectStatementRevisions(session.projectId)).toHaveLength(0);
  });
});
