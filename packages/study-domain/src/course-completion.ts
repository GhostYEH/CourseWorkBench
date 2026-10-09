/**
 * 课程完成度的纯函数（OMA-033）。
 *
 * 输入是「本课程版本引用的知识点」「每个知识点绑定的题目」与「本人真实提交的作答」，
 * 输出逐知识点与整课的完成状态。硬约束：
 * - 只统计 `kind === 'real'` 且 `actorType === 'human_learner'` 的提交；AI/模拟分区不计入；
 * - 一个知识点只有「全部绑定题目都已提交」才算 completed；未作答不自动完成；
 * - 客观题正确数来自冻结答案的确定性判分（`grading.earned` 满分为正确）；简答待判分不算正确，
 *   但计入「已作答」并标记 pendingReview。
 */

export interface CompletionAttemptFact {
  questionId: string;
  /** 本人真实提交。 */
  kind: 'real' | 'simulation';
  actorType: 'human_learner' | 'teacher_ai' | 'peer_ai' | 'system';
  /** 客观题确定性判分结果；简答待判分为 `pending_review`（correct/earned 均为 null）。 */
  grading: { status: 'correct' | 'incorrect' | 'pending_review'; correct: boolean | null } | null;
}

export interface CompletionQuestionFact {
  questionId: string;
  knowledgeIds: readonly string[];
}

export interface CompletionKnowledgeResult {
  knowledgeId: string;
  questionCount: number;
  answeredCount: number;
  correctCount: number;
  pendingReview: boolean;
  status: 'not_started' | 'in_progress' | 'completed';
}

export interface CourseCompletionResult {
  knowledge: CompletionKnowledgeResult[];
  totals: {
    knowledgeCount: number;
    questionCount: number;
    answeredCount: number;
    correctCount: number;
  };
  status: 'not_started' | 'in_progress' | 'completed';
  pendingFeedback: number;
}

const isHumanReal = (attempt: CompletionAttemptFact): boolean =>
  attempt.kind === 'real' && attempt.actorType === 'human_learner';

/** 取某道题最近一次本人真实提交（作答不可变，取首条即可；这里用 last 兼容重做新提交）。 */
const latestHumanAttempt = (
  attempts: readonly CompletionAttemptFact[],
  questionId: string,
): CompletionAttemptFact | null => {
  let found: CompletionAttemptFact | null = null;
  for (const attempt of attempts) {
    if (attempt.questionId !== questionId || !isHumanReal(attempt)) continue;
    found = attempt;
  }
  return found;
};

export const computeCourseCompletion = (input: {
  knowledgeIds: readonly string[];
  questions: readonly CompletionQuestionFact[];
  attempts: readonly CompletionAttemptFact[];
}): CourseCompletionResult => {
  const questionsByKnowledge = new Map<string, string[]>();
  for (const knowledgeId of input.knowledgeIds) questionsByKnowledge.set(knowledgeId, []);
  for (const question of input.questions) {
    for (const knowledgeId of question.knowledgeIds) {
      const list = questionsByKnowledge.get(knowledgeId);
      if (list && !list.includes(question.questionId)) list.push(question.questionId);
    }
  }
  const knowledge: CompletionKnowledgeResult[] = [];
  let pendingFeedback = 0;
  for (const knowledgeId of input.knowledgeIds) {
    const questionIds = questionsByKnowledge.get(knowledgeId) ?? [];
    let answeredCount = 0;
    let correctCount = 0;
    let pendingReview = false;
    for (const questionId of questionIds) {
      const attempt = latestHumanAttempt(input.attempts, questionId);
      if (!attempt) continue;
      answeredCount += 1;
      const grading = attempt.grading;
      if (grading === null || grading.status === 'pending_review') pendingReview = true;
      else if (grading.correct === true) correctCount += 1;
    }
    if (pendingReview) pendingFeedback += 1;
    const status: CompletionKnowledgeResult['status'] =
      questionIds.length === 0
        ? 'not_started'
        : answeredCount === 0
          ? 'not_started'
          : answeredCount >= questionIds.length
            ? 'completed'
            : 'in_progress';
    knowledge.push({
      knowledgeId,
      questionCount: questionIds.length,
      answeredCount,
      correctCount,
      pendingReview,
      status,
    });
  }
  const distinctQuestions = [
    ...new Set(knowledge.flatMap((item) => questionsByKnowledge.get(item.knowledgeId) ?? [])),
  ];
  const answered = distinctQuestions
    .map((questionId) => latestHumanAttempt(input.attempts, questionId))
    .filter((attempt) => attempt !== null);
  const totals = {
    knowledgeCount: input.knowledgeIds.length,
    questionCount: distinctQuestions.length,
    answeredCount: answered.length,
    correctCount: answered.filter((attempt) => attempt.grading?.correct === true).length,
  };
  const status: CourseCompletionResult['status'] =
    totals.knowledgeCount === 0 || totals.answeredCount === 0
      ? 'not_started'
      : knowledge.every((item) => item.status === 'completed')
        ? 'completed'
        : 'in_progress';
  return { knowledge, totals, status, pendingFeedback };
};
