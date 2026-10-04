import { StudyError } from '@sew/study-contracts';
import type { Session } from './service';
import { checkRecovery } from './classroom-recovery';

/** Check new effects, after reading an existing command receipt. Stop actions stay available. */
export const assertRecoveryExecution = (session: Session, sessionId: string, action: 'teach' | 'learner-answered' = 'teach'): void => {
  const classroom = session.store.getClassroomSession(sessionId, session.projectId);
  if (!classroom) throw new StudyError('NOT_FOUND');
  // The course authoring workspace can run reviewed cards before a stage is attached.
  // Its existing version/source guard remains authoritative; no four-layer stage exists yet.
  if (!classroom.stageId) return;
  const checkpoint = checkRecovery(session, sessionId);
  if (checkpoint.continuation === 'blocked') throw new StudyError('VERSION_CONFLICT', { reason: 'classroom_recovery_blocked',
    layers: checkpoint.layers.filter(layer => layer.status === 'blocked').map(layer => ({ layer: layer.layer, reason: layer.reason })) },
  '课堂恢复核对未通过，请先处理阻断原因；结束或取消仍可使用。');
  if (checkpoint.continuation === 'terminal') throw new StudyError('RUN_TERMINATED', { reason: 'classroom_recovery_terminal' });
  if (action === 'learner-answered') {
    if (checkpoint.layers.some(layer => layer.reason === 'quiz_submission_unconfirmed')) {
      throw new StudyError('CLASSROOM_AWAITING_LEARNER', { reason: 'classroom_submission_unconfirmed' });
    }
    if (classroom.status !== 'awaiting_learner') throw new StudyError('INVALID_ARGUMENT', { reason: 'not_awaiting_learner' });
  } else if (checkpoint.continuation !== 'continue') throw new StudyError('CLASSROOM_AWAITING_LEARNER', { reason: 'classroom_recovery_waiting' });
};
