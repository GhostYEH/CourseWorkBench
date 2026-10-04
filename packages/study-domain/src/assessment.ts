import { StudyError, selectedAnswerSetSchema, questionAssessmentSchema, type QuestionAssessmentDto, type AssessmentGradingDto } from '@sew/study-contracts';

/** Objective grading is exact; short answers retain uncertainty until reviewed. */
export const gradeQuestionAssessment = (assessment: QuestionAssessmentDto, answerText: string): AssessmentGradingDto => {
  const rule = questionAssessmentSchema.parse(assessment);
  const base = { maxScore: rule.maxScore, answerVersion: rule.answerVersion };
  if (rule.type === 'short_answer') return { ...base, status: 'pending_review', correct: null, earned: null, basis: 'short_answer_requires_review' };
  let answers: string[];
  if (rule.type === 'single') answers = [answerText];
  else {
    let parsed: unknown;
    try { parsed = JSON.parse(answerText); } catch { throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_multiple_answer' }); }
    const result = selectedAnswerSetSchema.safeParse(parsed);
    if (!result.success) throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_multiple_answer' });
    answers = result.data;
  }
  const keys = new Set(rule.options.map((option) => option.value));
  if (new Set(answers).size !== answers.length || answers.some((answer) => !keys.has(answer))) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_choice_answer' });
  }
  const correct = answers.length === rule.correctAnswers.length && answers.every((answer) => rule.correctAnswers.includes(answer));
  return { ...base, status: correct ? 'correct' : 'incorrect', correct, earned: correct ? rule.maxScore : 0, basis: 'exact_answer_set' };
};
