import type { AssessmentGradingDto, AttemptGradeCandidateDto } from '@sew/study-contracts';

export function effectiveGradeLabel(grading: AssessmentGradingDto): string {
  if (grading.status === 'pending_review' || grading.earned === null) return '待判分';
  const result = grading.earned === grading.maxScore ? '满分' : grading.earned === 0 ? '未得分' : '部分得分';
  return `${result} · ${grading.earned}/${grading.maxScore} 分`;
}

export function candidateApprovalBlocked(candidate: AttemptGradeCandidateDto, currentVersion: number): string | null {
  if (candidate.status !== 'pending') return '此候选已处理';
  if (candidate.expectedReviewVersion !== currentVersion) return '候选基于旧审核版本，请重新生成或独立人工评分';
  if (candidate.proposedEarned === null) return '模型没有确定得分，请独立人工评分';
  return null;
}
