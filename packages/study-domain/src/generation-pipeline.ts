import { StudyError } from '@sew/study-contracts';
import type {
  GenerationPipelineStage,
  GenerationPipelineTask,
  GenerationPipelineStageState,
} from '../../study-contracts/src/generation-pipeline';

const now = (): string => new Date().toISOString();
const terminal = (status: GenerationPipelineTask['status']): boolean =>
  status === 'stopped' || status === 'completed';

export const createGenerationPipelineTask = (
  input: Pick<
    GenerationPipelineTask,
    | 'taskId'
    | 'projectId'
    | 'lessonId'
    | 'version'
    | 'bundleId'
    | 'bundleDigest'
    | 'roleConfigDigest'
    | 'teachingPreferenceVersion'
    | 'title'
    | 'statementIds'
    | 'questionIds'
    | 'intentDigest'
    | 'instruction'
  >,
): GenerationPipelineTask => {
  const timestamp = now();
  const stages: GenerationPipelineStageState[] = (
    ['course-draft', 'outline', 'courseware', 'teaching-profile'] as const
  ).map((stage) => ({
    stage,
    status: 'pending',
    attempts: 0,
    reviewStatus: stage === 'courseware' ? 'external' : 'not-required',
    reviewRequestId: null,
    requestId: null,
    message: null,
    startedAt: null,
    completedAt: null,
    output: null,
  }));
  return {
    ...input,
    status: 'ready',
    createdAt: timestamp,
    updatedAt: timestamp,
    stages,
    candidateOnly: true,
  };
};

export const currentGenerationPipelineStage = (
  task: GenerationPipelineTask,
): GenerationPipelineStageState | null =>
  task.stages.find((item) => item.status !== 'completed' || item.reviewStatus === 'pending') ??
  null;

export const beginGenerationPipelineStage = (
  task: GenerationPipelineTask,
  stage: GenerationPipelineStage,
  requestId: string,
): GenerationPipelineTask => {
  if (terminal(task.status))
    throw new StudyError('STEP_ALREADY_COMMITTED', { status: task.status });
  const current = currentGenerationPipelineStage(task);
  if (!current || current.stage !== stage) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'generation_pipeline_stage_order',
      expected: current?.stage ?? null,
      actual: stage,
    });
  }
  if (current.status === 'running')
    throw new StudyError('VERSION_CONFLICT', { reason: 'generation_pipeline_stage_running' });
  if (current.status === 'completed')
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'generation_pipeline_review_required',
      stage,
    });
  if (current.status === 'blocked')
    throw new StudyError('VERSION_CONFLICT', { reason: 'generation_pipeline_stage_blocked' });
  const timestamp = now();
  return {
    ...task,
    status: 'running',
    updatedAt: timestamp,
    stages: task.stages.map((item) =>
      item.stage === stage
        ? {
            ...item,
            status: 'running',
            attempts: item.attempts + 1,
            requestId,
            message: null,
            startedAt: timestamp,
            completedAt: null,
          }
        : item,
    ),
  };
};

export const settleGenerationPipelineStage = (
  task: GenerationPipelineTask,
  stage: GenerationPipelineStage,
  result: { ok: boolean; message: string; output?: unknown; blocked?: boolean },
): GenerationPipelineTask => {
  const timestamp = now();
  const status: GenerationPipelineStageState['status'] = result.ok
    ? 'completed'
    : result.blocked
      ? 'blocked'
      : 'failed';
  const reviewStatus: GenerationPipelineStageState['reviewStatus'] = result.ok
    ? stage === 'courseware'
      ? 'external'
      : 'pending'
    : 'not-required';
  const stages = task.stages.map((item) =>
    item.stage === stage
      ? {
          ...item,
          status,
          reviewStatus,
          reviewRequestId: null,
          message: result.message.slice(0, 500),
          completedAt: timestamp,
          ...(result.output === undefined ? {} : { output: result.output }),
        }
      : item,
  );
  const nextStatus: GenerationPipelineTask['status'] = result.ok
    ? stages.every((item) => item.status === 'completed' && item.reviewStatus !== 'pending')
      ? 'completed'
      : 'paused'
    : result.blocked
      ? 'blocked'
      : 'failed';
  return { ...task, status: nextStatus, updatedAt: timestamp, stages };
};

export const retryGenerationPipelineStage = (
  task: GenerationPipelineTask,
  stage: GenerationPipelineStage,
  requestId: string,
): GenerationPipelineTask => {
  const current = currentGenerationPipelineStage(task);
  const target = task.stages.find((item) => item.stage === stage);
  if (!target || current?.stage !== stage || target.status !== 'failed') {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'generation_pipeline_retry_not_failed_stage',
      stage,
    });
  }
  if (!requestId || requestId === target.requestId) {
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'generation_pipeline_retry_nonce_must_change',
    });
  }
  const timestamp = now();
  return {
    ...task,
    status: 'paused',
    updatedAt: timestamp,
    stages: task.stages.map((item) =>
      item.stage === stage
        ? { ...item, requestId, message: null, startedAt: null, completedAt: null }
        : item,
    ),
  };
};

export const stopGenerationPipelineTask = (
  task: GenerationPipelineTask,
): GenerationPipelineTask => {
  if (terminal(task.status)) return task;
  return { ...task, status: 'stopped', updatedAt: now() };
};

export const markGenerationPipelineStageReviewed = (
  task: GenerationPipelineTask,
  stage: GenerationPipelineStage,
  decision: 'approved' | 'rejected',
  requestId: string,
): GenerationPipelineTask => {
  const target = task.stages.find((item) => item.stage === stage);
  if (!target || target.status !== 'completed' || target.reviewStatus !== 'pending') {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'generation_pipeline_review_not_pending',
      stage,
    });
  }
  const timestamp = now();
  const stages = task.stages.map((item) =>
    item.stage === stage
      ? {
          ...item,
          reviewStatus: decision,
          reviewRequestId: requestId,
          message:
            decision === 'approved'
              ? item.message
              : '候选已拒绝；没有写入课程、场景计划或教学配置。',
          completedAt: timestamp,
        }
      : item,
  );
  const next = {
    ...task,
    status:
      decision === 'rejected' && stage === 'course-draft'
        ? ('stopped' as const)
        : stages.every((item) => item.status === 'completed' && item.reviewStatus !== 'pending')
          ? ('completed' as const)
          : ('paused' as const),
    updatedAt: timestamp,
    stages,
  };
  return next;
};
