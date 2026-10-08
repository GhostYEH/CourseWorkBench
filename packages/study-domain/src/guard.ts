/**
 * 模型调用前的统一 guard（M2-A）。
 *
 * 连接诊断已实现限额、期限与取消，但它不核对来源：诊断端口能连通不代表可以据此生成教学内容。
 * 生成与上课调用必须先把四件事判完 —— 有没有已启动的 run、引用的来源是否仍然准入、
 * 课程是否已审核发布、本 run 的额度是否用满。判定不通过时一次 provider 请求都不发出。
 */

import {
  StudyError,
  type FrozenVersionsDto,
  type LessonStatus,
  type ModelCallPurpose,
  type RunState,
} from '@sew/study-contracts';
import { assertLessonKnowledgeAdmitted } from './lesson';

export interface ModelCallGuardFacts {
  purpose: ModelCallPurpose;
  /** 当前 run 及其冻结快照；null 表示还没有由已确认计划启动的 run。 */
  run: { state: RunState; frozen: FrozenVersionsDto } | null;
  /** 服务端此刻重新计算的知识清单摘要，用于发现「冻结之后来源变了」。 */
  currentKnowledgeTableDigest: string;
  referencedKnowledgeIds: readonly string[];
  admittedKnowledgeIds: ReadonlySet<string>;
  /** 上课用途必须给出课程事实；草案生成的课程为 null。 */
  lesson: { status: LessonStatus | null; reviewApproved: boolean } | null;
  /** 本 run 已累计的调用次数与 token（含失败尝试）。 */
  usage: { calls: number; tokens: number; activeElapsedMs?: number };
  limits: { maxCalls: number; maxTokens: number; maxWallClockMs?: number };
}

const TERMINAL_RUN_STATES: readonly RunState[] = ['completed', 'cancelled', 'failed'];

/** 阻断顺序：任务状态 → 额度（次数/Token/执行时限）→ 来源版本漂移 → 单点准入 → 课程审核发布。 */
export const assertModelCallAdmitted = (facts: ModelCallGuardFacts): void => {
  if (!facts.run) throw new StudyError('PLAN_NOT_CONFIRMED', { reason: 'no_run' });
  if (TERMINAL_RUN_STATES.includes(facts.run.state)) {
    throw new StudyError('RUN_TERMINATED', { state: facts.run.state });
  }
  if (facts.usage.calls >= facts.limits.maxCalls) {
    throw new StudyError('BUDGET_EXCEEDED', {
      reason: 'calls', used: facts.usage.calls, limit: facts.limits.maxCalls,
    });
  }
  if (facts.usage.tokens >= facts.limits.maxTokens) {
    throw new StudyError('BUDGET_EXCEEDED', {
      reason: 'tokens', used: facts.usage.tokens, limit: facts.limits.maxTokens,
    });
  }
  // 执行时限只累计真正在跑的外部调用；等待本人输入的时间不计入（《规划书》6.4）。
  if (facts.limits.maxWallClockMs !== undefined && facts.usage.activeElapsedMs !== undefined
    && facts.usage.activeElapsedMs >= facts.limits.maxWallClockMs) {
    throw new StudyError('BUDGET_EXCEEDED', {
      reason: 'wall_clock', used: facts.usage.activeElapsedMs, limit: facts.limits.maxWallClockMs,
    });
  }
  if (facts.run.frozen.knowledgeTableDigest !== facts.currentKnowledgeTableDigest) {
    throw new StudyError('KNOWLEDGE_INVALIDATED', { reason: 'knowledge_table_changed' });
  }
  assertLessonKnowledgeAdmitted(facts.referencedKnowledgeIds, facts.admittedKnowledgeIds);
  if (facts.purpose === 'teaching_prompt' || facts.purpose === 'collab_teaching_ai' || facts.purpose === 'pbl_guidance') {
    if (!facts.lesson) {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'lesson_required' });
    }
    if (facts.lesson.status !== 'published' || !facts.lesson.reviewApproved) {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
        reason: 'lesson_not_published_or_unreviewed', status: facts.lesson.status,
      });
    }
  }
};

/**
 * 额度判定只看「已用是否已达上限」，不用「再加一次会不会超」。
 * 后者会在最后一次调用还没返回时就放行，累计口径也因此对不上台账。
 */
export const modelCallQuotaRemaining = (
  facts: Pick<ModelCallGuardFacts, 'usage' | 'limits'>,
): { calls: number; tokens: number } => ({
  calls: Math.max(0, facts.limits.maxCalls - facts.usage.calls),
  tokens: Math.max(0, facts.limits.maxTokens - facts.usage.tokens),
});
