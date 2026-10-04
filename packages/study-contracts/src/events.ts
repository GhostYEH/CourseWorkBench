/**
 * 运行事件合同（《Electron 开发设计》第 6 节）。
 *
 * 每项事件携带项目身份、run ID、步骤 ID 与递增事件序号；恢复只按已提交序号进行，
 * 连接中断不自动重放已经执行的动作。
 */

import type { FrozenVersionsDto } from './plan';
import type { ActorType, RunState } from './status';
import type { ProjectGeneration, ProjectId, RunId, StepId } from './ids';

export { RUN_EVENT_TYPES } from './status';
export type { RunEventType } from './status';
import type { RunEventType } from './status';

export interface RunEventBase {
  type: RunEventType;
  projectId: ProjectId;
  /** 打开代次：项目切换后旧事件一律丢弃。 */
  generation: ProjectGeneration;
  runId: RunId;
  stepId: StepId | null;
  /** 同一 run 内单调递增，从 1 开始。 */
  seq: number;
  at: string;
  actorType: ActorType;
}

export interface RunStartedEvent extends RunEventBase {
  type: 'run_started';
  state: RunState;
  frozen: FrozenVersions;
}

export interface StepStartedEvent extends RunEventBase {
  type: 'step_started';
  label: string;
}

/** 流式文字只展示为「生成中的草案」，不能作为已发布课程或已保存知识点。 */
export interface DraftDeltaEvent extends RunEventBase {
  type: 'draft_delta';
  text: string;
}

export interface ProposalCreatedEvent extends RunEventBase {
  type: 'proposal_created';
  proposalIds: string[];
}

export interface ReviewRequiredEvent extends RunEventBase {
  type: 'review_required';
  reason: string;
  pending: string[];
}

export interface AnswerRequiredEvent extends RunEventBase {
  type: 'answer_required';
  questionId: string;
}

export interface StepCommittedEvent extends RunEventBase {
  type: 'step_committed';
  receiptId: string;
  /** 重复请求命中同一 receipt 时为 true。 */
  deduplicated: boolean;
}

export interface RunCompletedEvent extends RunEventBase {
  type: 'run_completed';
  state: RunState;
}

export interface RunFailedEvent extends RunEventBase {
  type: 'run_failed';
  code: string;
  message: string;
}

export interface RunCancelledEvent extends RunEventBase {
  type: 'run_cancelled';
  reason: string;
}

export type RunEvent =
  | RunStartedEvent
  | StepStartedEvent
  | DraftDeltaEvent
  | ProposalCreatedEvent
  | ReviewRequiredEvent
  | AnswerRequiredEvent
  | StepCommittedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent;

/**
 * 开始 run 时冻结的版本集合，保证恢复后仍是同一套事实。
 * 运行时形状由 `plan.ts` 的 `frozenVersionsSchema` 校验，这里不再另写一份字段清单。
 */
export type FrozenVersions = FrozenVersionsDto;
