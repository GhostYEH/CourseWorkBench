import { createHash } from 'node:crypto';
import { StudyError, type DirectorStateDto, type DirectorStepDto } from '@sew/study-contracts';
import { canonicalJson } from './classroom';

/** Digest binds the exact candidate text and all authority anchors, not just a display ID. */
export const directorCandidateDigest = (
  state: DirectorStateDto,
  step: DirectorStepDto,
  text: string,
  explanationId: string | null,
): string =>
  createHash('sha256')
    .update(
      canonicalJson({
        directorId: state.directorId,
        projectId: state.projectId,
        runId: state.runId,
        sessionId: state.sessionId,
        lessonId: state.lessonId,
        lessonVersion: state.lessonVersion,
        bundleDigest: state.bundleDigest,
        documentDigest: state.documentDigest,
        roleDigest: state.roleDigest,
        sceneId: step.sceneId,
        stepId: step.stepId,
        role: step.role,
        roleProfileId: step.roleProfileId,
        statementIds: step.statementIds,
        text,
        explanationId,
      }),
    )
    .digest('hex');

export const directorCurrentStep = (state: DirectorStateDto): DirectorStepDto | null =>
  state.steps.find(
    (step) =>
      step.sceneId === state.sceneIds[state.sceneIndex] &&
      !['delivered', 'skipped'].includes(step.state),
  ) ?? null;

export const assertDirectorContinuable = (
  state: DirectorStateDto,
  classroomStatus: string,
): void => {
  if (['completed', 'stopped'].includes(state.state))
    throw new StudyError('RUN_TERMINATED', { reason: 'director_terminal' });
  if (classroomStatus === 'awaiting_learner') throw new StudyError('CLASSROOM_AWAITING_LEARNER');
  if (classroomStatus !== 'in_class') throw new StudyError('RUN_TERMINATED');
  const step = directorCurrentStep(state);
  if (step && ['started', 'unknown', 'failed'].includes(step.state))
    throw new StudyError(
      'VERSION_CONFLICT',
      { reason: 'director_no_auto_replay' },
      '此任务已派发或结果未确认，不会重发。请读回记录；新调用需停止后明确新建调度。',
    );
  if (step?.state === 'pending_review')
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'director_candidate_pending' });
};
