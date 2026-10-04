import { StudyError, newId } from '@sew/study-contracts';
import type { Session } from './service';

/** Synchronous effects hold one authoritative lease and commit it with the effect. */
export const withRoomTeacher = <T>(session: Session, sessionId: string, action: () => T): T => session.store.transaction(() => {
  const room = session.store.getClassroomRoomForSession(session.projectId, sessionId, session.learnerUid);
  if (!room) return action();
  const lease = session.store.acquireClassroomTeacherLease({
    projectId: session.projectId, roomId: room.roomId, executorId: newId('executor'), ttlMs: 5000,
  }, session.learnerUid);
  const check = { projectId: session.projectId, roomId: room.roomId, leaseId: lease.leaseId,
    executorId: lease.executorId, runGeneration: lease.runGeneration };
  session.store.assertClassroomTeacherLease(check, session.learnerUid);
  const result = action();
  session.store.releaseClassroomTeacherLease(check, session.learnerUid);
  return result;
});

export const openRoomClassroom = (session: Session, input: {
  lessonId: string; stageId: string | null; sceneId: string; roomId?: string;
}, open: () => ReturnType<Session['store']['openClassroomSession']>) => session.store.transaction(() => {
  if (!input.roomId) return open();
  const room = session.store.getClassroomRoom(session.projectId, input.roomId, session.learnerUid);
  if (!room) throw new StudyError('NOT_FOUND');
  if (room.course.lessonId !== input.lessonId || room.course.stageId !== input.stageId || room.currentSceneId !== input.sceneId) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'room_classroom_context_changed' }, '课堂版本或场景已变化，请重新进入该课堂。');
  }
  const classroom = open();
  session.store.bindClassroomRoomSession(session.projectId, room.roomId, classroom.sessionId, session.learnerUid);
  return classroom;
});
