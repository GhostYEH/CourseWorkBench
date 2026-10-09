import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { courseCompletionSchema } from '@sew/study-contracts';
import { computeCourseCompletion } from '@sew/study-domain';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { readCourseCompletion } from '../apps/learning/lib/server/course-completion-service';
import { GET as completionGet } from '../apps/learning/app/api/study/lessons/completion/route';

/**
 * 课程完成页与学习反馈（OMA-033）。
 *
 * 固定：① 完成状态只依据本人真实提交，未作答不自动完成；② AI/模拟分区不计入；
 * ③ 简答待判分计入已作答但标记 pendingReview；④ 只读页面不写任何事实。
 */
describe('OMA-033 课程完成度', () => {
  it('整课题目数按题号去重，多知识点题仍只计一次作答', () => {
    const result = computeCourseCompletion({
      knowledgeIds: ['k1', 'k2'],
      questions: [{ questionId: 'q1', knowledgeIds: ['k1', 'k2'] }],
      attempts: [
        {
          questionId: 'q1',
          kind: 'real',
          actorType: 'human_learner',
          grading: { status: 'correct', correct: true },
        },
      ],
    });
    expect(result.totals).toEqual({
      knowledgeCount: 2,
      questionCount: 1,
      answeredCount: 1,
      correctCount: 1,
    });
    expect(result.knowledge.map((item) => item.answeredCount)).toEqual([1, 1]);
  });
  it('纯函数：只统计本人真实提交，未作答不自动完成，模拟不计入', () => {
    const result = computeCourseCompletion({
      knowledgeIds: ['k1', 'k2'],
      questions: [
        { questionId: 'q1', knowledgeIds: ['k1'] },
        { questionId: 'q2', knowledgeIds: ['k1'] },
        { questionId: 'q3', knowledgeIds: ['k2'] },
      ],
      attempts: [
        {
          questionId: 'q1',
          kind: 'real',
          actorType: 'human_learner',
          grading: { status: 'correct', correct: true },
        },
        // 模拟分区即使判对也不计入。
        {
          questionId: 'q2',
          kind: 'simulation',
          actorType: 'human_learner',
          grading: { status: 'correct', correct: true },
        },
        // 教师 AI 不计入。
        {
          questionId: 'q2',
          kind: 'real',
          actorType: 'teacher_ai',
          grading: { status: 'correct', correct: true },
        },
      ],
    });
    const k1 = result.knowledge.find((item) => item.knowledgeId === 'k1')!;
    expect(k1).toMatchObject({
      questionCount: 2,
      answeredCount: 1,
      correctCount: 1,
      status: 'in_progress',
    });
    const k2 = result.knowledge.find((item) => item.knowledgeId === 'k2')!;
    expect(k2).toMatchObject({ questionCount: 1, answeredCount: 0, status: 'not_started' });
    expect(result.totals).toMatchObject({
      knowledgeCount: 2,
      questionCount: 3,
      answeredCount: 1,
      correctCount: 1,
    });
    expect(result.status).toBe('in_progress');
  });

  it('纯函数：全部知识点答完才算 completed；简答待判分标记 pendingReview', () => {
    const allAnswered = computeCourseCompletion({
      knowledgeIds: ['k1'],
      questions: [{ questionId: 'q1', knowledgeIds: ['k1'] }],
      attempts: [
        {
          questionId: 'q1',
          kind: 'real',
          actorType: 'human_learner',
          grading: { status: 'pending_review', correct: null },
        },
      ],
    });
    expect(allAnswered.knowledge[0]).toMatchObject({
      answeredCount: 1,
      status: 'completed',
      pendingReview: true,
    });
    expect(allAnswered.status).toBe('completed');
    expect(allAnswered.pendingFeedback).toBe(1);
  });

  it('只读页面：未作答时 status=not_started 且不写任何事实', async () => {
    let directory: string | null = null;
    let session: Session | null = null;
    try {
      directory = mkdtempSync(join(tmpdir(), 'sew-completion-'));
      session = openProjectFromDisk(directory);
      const s = session;
      const material = s.store.importMaterial({
        projectId: s.projectId,
        displayName: '来源.md',
        materialType: 'md',
        rawText: '函数单调性定义。',
      });
      const proposed = s.store.createProposal({
        projectId: s.projectId,
        name: '单调性',
        concept: '增函数定义',
        conditions: '同一区间',
        scopeStatus: 'in_syllabus',
        prerequisites: [],
        evidence: [
          {
            materialId: material.material.materialId,
            revision: 1,
            segmentId: 'S001',
            use: 'concept_basis',
          },
        ],
        acceptance: '',
        priority: 'medium',
        proposedBy: 'user',
      });
      const knowledgeId = s.store.applyReview({
        proposalId: proposed.proposalId,
        decision: 'approved',
        expectedRevision: proposed.revision,
        semanticReviewed: true,
      }).knowledgePoint!.knowledgeId;
      const question = s.store.createQuestion({
        assessment: {
          type: 'single',
          options: [
            { value: 'A', label: 'f(x1)>f(x2)' },
            { value: 'B', label: 'f(x1)<f(x2)' },
          ],
          correctAnswers: ['B'],
          maxScore: 5,
          rubric: '',
          answerVersion: 1,
          schemaVersion: 1,
        },
        stem: '增函数判定',
        answer: 'B',
        solution: '定义要求 x1<x2 时 f(x1)<f(x2)。',
        knowledgeIds: [knowledgeId],
        requestedOrigin: 'material_rewrite',
        originRecord: null,
      });
      s.store.savePlanVersion(s.projectId, 1, 'confirmed', {
        payloadVersion: 1,
        goal: '学习单调性',
        examDate: null,
        dailyMinutes: 30,
        tasks: [
          {
            knowledgeId,
            name: '单调性',
            minutes: 30,
            acceptance: '',
            evidence: [{ materialId: material.material.materialId, segmentId: 'S001' }],
          },
        ],
        gaps: [],
        basis: '测试',
        confirmedTaskKnowledgeIds: [knowledgeId],
      });
      s.store.startPlanRun(s.projectId);
      const bundle = s.store.buildLessonBundle(
        s.projectId,
        [{ knowledgeId, text: '增函数定义', conditions: '同一区间' }],
        [question.question.questionId],
      );
      const lesson = s.store.createLessonDraft({
        projectId: s.projectId,
        lessonId: null,
        title: '单调性',
        bundleId: bundle.bundleId,
        statementIds: [bundle.bundle.statements[0]!.statementId],
        questionIds: [question.question.questionId],
      });

      const before = s.store.listAttempts(undefined, 'formal').length;
      const completion = readCourseCompletion(s, {
        lessonId: lesson.lessonId,
        version: lesson.version,
      });
      expect(courseCompletionSchema.safeParse(completion).success).toBe(true);
      expect(completion.status).toBe('not_started');
      expect(completion.totals.answeredCount).toBe(0);
      // 只读：不写任何作答。
      expect(s.store.listAttempts(undefined, 'formal').length).toBe(before);

      // HTTP 边界：返回合同形状。
      const response = await completionGet(
        new Request(
          `http://127.0.0.1/api/study/lessons/completion?projectId=${encodeURIComponent(
            s.projectId,
          )}&generation=${s.generation}&lessonId=${encodeURIComponent(lesson.lessonId)}&version=${lesson.version}`,
        ),
      );
      expect(response.status).toBe(200);
    } finally {
      if (session) closeProject();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
});
