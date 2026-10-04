import { StudyError, type AssessmentGradingDto } from '@sew/study-contracts';

/** Semantic confirmation is a separate human action, never inferred from a model proposal. */
export function gradeReviewedAnswer(input: { earned: number; maxScore: number; answerVersion: number; semanticReviewed: boolean; basis: string; uncertainty: string }): AssessmentGradingDto {
  if (input.semanticReviewed !== true || !input.basis.trim() || !input.uncertainty.trim() || !Number.isFinite(input.earned) || input.earned < 0 || input.earned > input.maxScore) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_semantic_grade' });
  }
  const correct = input.earned === input.maxScore;
  return { status: correct ? 'correct' : 'incorrect', correct, earned: input.earned, maxScore: input.maxScore, answerVersion: input.answerVersion, basis: input.basis.trim() };
}
