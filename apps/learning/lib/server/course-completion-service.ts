/**
 * 课程完成页服务（OMA-033）。
 *
 * 只读：把「本课程版本引用的知识点」「每个知识点绑定的题目」与「本人真实提交的作答」交给
 * 领域纯函数 `computeCourseCompletion`，得到逐知识点与整课完成状态。不写任何事实、不更新掌握。
 */

import { StudyError } from '@sew/study-contracts';
import type { CourseCompletionDto } from '@sew/study-contracts';
import { computeCourseCompletion } from '@sew/study-domain';
import { assertScope, type Session } from './service';

export const readCourseCompletion = (
  session: Session,
  input: { lessonId: string; version: number },
): CourseCompletionDto => {
  assertScope({ projectId: session.projectId, generation: session.generation });
  const lesson = session.store.getLessonVersion(input.lessonId, input.version, session.projectId);
  if (!lesson)
    throw new StudyError('NOT_FOUND', { lessonId: input.lessonId, version: input.version });
  const bundle = session.store.getEvidenceBundle(session.projectId, lesson.bundleId);
  if (!bundle) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
  // 本版本引用的知识点来自冻结证据包：陈述的知识点 + 题目的知识点（与准入/装配口径一致）。
  const statements = bundle.bundle.statements.filter((statement) =>
    lesson.statementIds.includes(statement.statementId),
  );
  const questions = bundle.bundle.questions.filter((question) =>
    lesson.questionIds.includes(question.questionId),
  );
  const knowledgeIds = [
    ...new Set([
      ...statements.map((statement) => statement.knowledgeId),
      ...questions.flatMap((question) => question.knowledgeIds),
    ]),
  ].sort();
  const completion = computeCourseCompletion({
    knowledgeIds,
    questions: questions.map((question) => ({
      questionId: question.questionId,
      knowledgeIds: question.knowledgeIds,
    })),
    // 只统计本人真实提交；模拟/同学/教师分区由领域函数再过滤一次。
    attempts: session.store
      .listAttempts(undefined, 'formal')
      .reverse()
      .map((attempt) => ({
        questionId: attempt.questionId,
        kind: attempt.kind,
        actorType: attempt.actorType as 'human_learner' | 'teacher_ai' | 'peer_ai' | 'system',
        grading: attempt.grading
          ? {
              status: attempt.grading.status,
              correct: attempt.grading.correct,
            }
          : null,
      })),
  });
  return {
    lessonId: lesson.lessonId,
    lessonVersion: lesson.version,
    knowledge: completion.knowledge,
    totals: completion.totals,
    status: completion.status,
    pendingFeedback: completion.pendingFeedback,
    generatedAt: new Date().toISOString(),
  };
};
