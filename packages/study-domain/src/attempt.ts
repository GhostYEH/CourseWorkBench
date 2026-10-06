/**
 * 作答分区、判分与提交去重（《规划书》4.4 / 6.4）。
 *
 * 模拟作答与真实作答必须分区存储、显著标注。模拟数据可以参与软件评测，
 * 不能更新用户实际掌握状态。未作答、未反馈或仅点击完成，均不能自动标为掌握。
 */

import { StudyError } from '@sew/study-contracts';
import type { ActorType, AttemptKind, MasteryStatus } from '@sew/study-contracts';

export interface AttemptRequest {
  questionId: string;
  actorType: ActorType;
  kind: AttemptKind;
  answerText: string;
  processText: string;
}

export interface AttemptDecision {
  /** 实际落库分区。请求 real 但主体不是本人时被强制为 simulation。 */
  kind: AttemptKind;
  forcedSimulation: boolean;
  /** 真实作答才可能更新掌握状态；模拟作答始终为 null。 */
  masteryAfter: MasteryStatus | null;
  masteryUpdateAllowed: boolean;
  /** 缺少解题过程时无法确定具体错因，允许待确认。 */
  attributionStatus: 'pending_process' | 'proposed';
}

export const normalizeAnswer = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[。．.,，；;：:]+$/u, '');

export type AnswerVerdict = 'correct' | 'incorrect' | 'unknown';

export const judgeAnswer = (expected: string, actual: string): AnswerVerdict => {
  const e = normalizeAnswer(expected);
  const a = normalizeAnswer(actual);
  if (e.length === 0 || a.length === 0) return 'unknown';
  return e === a ? 'correct' : 'incorrect';
};

/**
 * 计算作答落库决策。调用方必须先检查幂等键是否已有收据；
 * 命中收据时直接返回既有结果，不重复写入。
 */
export const decideAttempt = (
  request: AttemptRequest,
  expectedAnswer: string,
  authoritativeVerdict?: AnswerVerdict,
): AttemptDecision => {
  const isHuman = request.actorType === 'human_learner';
  const forcedSimulation = !isHuman && request.kind === 'real';
  const kind: AttemptKind = isHuman ? request.kind : 'simulation';

  if (kind === 'simulation') {
    return {
      kind,
      forcedSimulation,
      masteryAfter: null,
      masteryUpdateAllowed: false,
      attributionStatus: request.processText.trim().length > 0 ? 'proposed' : 'pending_process',
    };
  }

  const verdict = authoritativeVerdict ?? judgeAnswer(expectedAnswer, request.answerText);
  const masteryAfter: MasteryStatus | null =
    verdict === 'correct' ? 'passed' : verdict === 'incorrect' ? 'to_reinforce' : null;

  return {
    kind,
    forcedSimulation,
    masteryAfter,
    masteryUpdateAllowed: verdict !== 'unknown',
    attributionStatus: request.processText.trim().length > 0 ? 'proposed' : 'pending_process',
  };
};

/** 模拟作答不得写入本人记录；写路径必须先经过该守卫。 */
export const assertRealWriteAllowed = (decision: AttemptDecision): void => {
  if (decision.kind !== 'real') {
    throw new StudyError('SIMULATION_WRITE_FORBIDDEN', { kind: decision.kind });
  }
};

/**
 * 步骤收据键：同一业务提交在任何重试下都必须得到同一个键，
 * 命中唯一键即读取既有结果，不重复添加知识点、作答或错题。
 */
export const buildStepKey = (...parts: Array<string | number | null | undefined>): string =>
  parts
    .filter((part) => part !== null && part !== undefined && `${part}`.length > 0)
    .map((part) => `${part}`)
    .join('|');

/** 答案展示范围（ANSWER-01）。 */
export interface AnswerDisplayPolicy {
  /** 是否展示标准答案与解析。 */
  showReference: boolean;
  /** 是否展示评分标准/规则。 */
  showRubric: boolean;
  /** 是否展示评分依据与不确定性（只在有确定评分版本后）。 */
  showGradingBasis: boolean;
  /** 不允许展示时的原因码；允许时为 null。 */
  reason:
    | 'no_personal_submission'
    | 'question_version_mismatch'
    | 'answer_version_mismatch'
    | 'grading_pending'
    | null;
}

/**
 * 答案展示规则（ANSWER-01）：**提交前一律不展示**答案、解析与评分规则。
 *
 * 判定完全由服务端事实给出，不接受「客户端说已经提交」：
 * - 必须存在一份**本人已提交**的作答，且题目/答案版本与该提交冻结的版本一致；
 * - 客观题提交后即可展示参考答案与解析（已判分）；
 * - 简答题在没有确定评分版本前只展示参考答案与评分标准，**不展示评分依据**——
 *   待判分时不能凭空给一个结论；
 * - 版本不一致（题目/答案在提交后被改写）时拒绝展示，避免用新版本的答案给旧提交「补一个结论」。
 */
export const answerDisplayPolicy = (facts: {
  hasPersonalSubmission: boolean;
  submissionQuestionRevision: number | null;
  submissionAnswerVersion: number | null;
  currentQuestionRevision: number;
  currentAnswerVersion: number;
  gradingStatus: 'correct' | 'incorrect' | 'pending_review' | null;
}): AnswerDisplayPolicy => {
  const denied = (reason: NonNullable<AnswerDisplayPolicy['reason']>): AnswerDisplayPolicy => ({
    showReference: false,
    showRubric: false,
    showGradingBasis: false,
    reason,
  });
  if (!facts.hasPersonalSubmission) return denied('no_personal_submission');
  if (
    facts.submissionQuestionRevision === null ||
    facts.submissionQuestionRevision !== facts.currentQuestionRevision
  ) {
    return denied('question_version_mismatch');
  }
  if (
    facts.submissionAnswerVersion === null ||
    facts.submissionAnswerVersion !== facts.currentAnswerVersion
  ) {
    return denied('answer_version_mismatch');
  }
  // 待判分：可以看参考答案与评分标准，但不能显示「评分依据」——那会暗示一个还没作出的结论。
  return {
    showReference: true,
    showRubric: true,
    showGradingBasis: facts.gradingStatus !== null && facts.gradingStatus !== 'pending_review',
    reason: null,
  };
};
