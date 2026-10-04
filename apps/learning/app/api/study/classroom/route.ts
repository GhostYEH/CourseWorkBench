import { z } from 'zod';
import {
  StudyError,
  classroomAdvanceSchema,
  classroomAnsweredSchema,
  classroomCloseSchema,
  classroomHandbackSchema,
  classroomOpenSchema,
  classroomPlaySchema,
  classroomPeersSchema,
  classroomPeerTurnSchemaInput,
  explanationCreateSchema,
  explanationEditSchema,
  explanationReviewSchema,
} from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import { toClassroomSessionDto, toExplanationDto } from '../../../../lib/server/dto';
import { abortActiveModelCalls } from '../../../../lib/server/model-call';
import { CLASSROOM_OWNER_LEARNER_KEY } from '../../../../lib/server/runtime-storage';
import { withRoomTeacher, openRoomClassroom } from '../../../../lib/server/room-teacher';
import { requestPeerTurn, peerRuntimeState } from '../../../../lib/server/classroom-peer';
import { assertRecoveryExecution } from '../../../../lib/server/classroom-recovery-guard';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  explanationCreateSchema,
  explanationEditSchema,
  explanationReviewSchema,
  classroomOpenSchema,
  classroomPlaySchema,
  classroomHandbackSchema,
  classroomAnsweredSchema,
  classroomAdvanceSchema,
  classroomCloseSchema,
  classroomPeersSchema,
  classroomPeerTurnSchemaInput,
]);

/**
 * 读取当前课堂现场。页面访问不创建会话、不推进动作，也不补播任何卡片。
 */
export const GET = route((request: Request) => {
  const query = z.object({ projectId: z.string().min(1).optional(), generation: z.coerce.number().int().positive().optional(),
    roomId: z.string().min(1).max(200).optional(), lessonId: z.string().min(1).optional() }).strict()
    .safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success || (query.data.projectId === undefined) !== (query.data.generation === undefined)) throw new StudyError('INVALID_ARGUMENT');
  const session = query.data.projectId && query.data.generation
    ? assertScope({ projectId: query.data.projectId, generation: query.data.generation }) : requireSession();
  let open = session.store.getOpenClassroomSession(session.projectId);
  if (query.data.roomId) {
    const room = session.store.getClassroomRoom(session.projectId, query.data.roomId, session.learnerUid);
    if (!room || room.status === 'ended') throw new StudyError('NOT_FOUND');
    const bound = open ? session.store.getClassroomRoomForSession(session.projectId, open.sessionId, session.learnerUid) : null;
    if (bound?.roomId !== room.roomId) open = null;
  }
  if (query.data.lessonId && open?.lessonId !== query.data.lessonId) open = null;
  return ok({
    state: open ? session.store.classroomState(session.projectId, open.sessionId) : null,
  }, { headers: { 'cache-control': 'no-store' } });
});

/**
 * 讲解卡与课堂动作命令（TEACH-01）。
 *
 * 本人身份由服务分配（learnerKey 不接受客户端提交）；卡片来源标记按命令写死为
 * 教师手写，模型产生的内容只能由服务侧生成路径登记。每个课堂动作都走收据去重。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const session = assertScope(body.scope);
  const projectId = session.projectId;

  switch (body.action) {
    case 'create-card': {
      const card = session.store.createExplanation({
        projectId,
        lessonId: body.lessonId,
        lessonVersion: body.lessonVersion,
        sceneId: body.sceneId,
        kind: body.kind,
        origin: 'teacher_authored',
        text: body.text,
        statementIds: body.statementIds,
      });
      return ok({ card: toExplanationDto(card) });
    }
    case 'edit-card':
      return ok({
        card: toExplanationDto(session.store.updateExplanationDraft({
          projectId,
          explanationId: body.explanationId,
          text: body.text,
          statementIds: body.statementIds,
        })),
      });
    case 'review-card':
      return ok({
        card: toExplanationDto(session.store.reviewExplanation({
          projectId,
          explanationId: body.explanationId,
          decision: body.decision,
          note: body.note,
        })),
      });
    case 'open': {
      const opened = openRoomClassroom(session, body, () => session.store.openClassroomSession({
        projectId,
        lessonId: body.lessonId,
        stageId: body.stageId,
        learnerKey: CLASSROOM_OWNER_LEARNER_KEY,
        sceneId: body.sceneId,
      }));
      return ok({ session: toClassroomSessionDto(opened) });
    }
    case 'play-next': {
      const played = session.store.getClassroomPlayReceipt(projectId, body.sessionId, body.requestId)
        ?? withRoomTeacher(session, body.sessionId, () => {
          assertRecoveryExecution(session, body.sessionId);
          return session.store.playNextExplanation(projectId, body.sessionId, body.requestId);
        });
      return ok({
        card: played.card,
        deduplicated: played.deduplicated,
        session: toClassroomSessionDto(played.session),
        playedIds: played.playedIds,
      });
    }
    case 'handback': {
      const handed = session.store.handBackToLearner(projectId, body.sessionId, body.reason);
      return ok({
        session: toClassroomSessionDto(handed),
        abortedCalls: abortActiveModelCalls({ projectId, sessionId: body.sessionId, reason: '教师已交还本人' }),
      });
    }
    case 'learner-answered':
      assertRecoveryExecution(session, body.sessionId, 'learner-answered');
      return ok({
        session: toClassroomSessionDto(session.store.markLearnerAnswered(projectId, body.sessionId)),
      });
    case 'advance-scene': {
      const advanced = session.store.transaction(() => {
        const receipt = session.store.getClassroomAdvanceReceipt(projectId, body.sessionId, body.sceneId, body.requestId);
        if (receipt) return receipt;
        assertRecoveryExecution(session, body.sessionId);
        const next = session.store.advanceClassroomScene(projectId, body.sessionId, body.sceneId, body.requestId);
        const room = session.store.getClassroomRoomForSession(projectId, body.sessionId, session.learnerUid);
        if (room && !next.deduplicated) session.store.setClassroomRoomScene({
          projectId, roomId: room.roomId, expectedRevision: room.revision,
          sceneId: body.sceneId, requestId: `classroom-scene:${body.requestId}`,
        }, session.learnerUid);
        return next;
      });
      return ok({
        session: toClassroomSessionDto(advanced.session),
        deduplicated: advanced.deduplicated,
        abortedCalls: abortActiveModelCalls({ projectId, sessionId: body.sessionId, reason: '课堂已切换场景' }),
      });
    }
    case 'close': {
      const closed = session.store.transaction(() => {
        const room = session.store.getClassroomRoomForSession(projectId, body.sessionId, session.learnerUid);
        const next = session.store.closeClassroomSession(projectId, body.sessionId, body.status, body.reason);
        if (room && room.status !== 'ended') session.store.closeClassroomRoom({ projectId, roomId: room.roomId,
          expectedRevision: room.revision, requestId: `classroom-close:${body.sessionId}` }, session.learnerUid);
        return next;
      });
      return ok({
        session: toClassroomSessionDto(closed),
        abortedCalls: abortActiveModelCalls({ projectId, sessionId: body.sessionId, reason: '课堂已结束' }),
      });
    }
    case 'set-peers': {
      const updated = withRoomTeacher(session, body.sessionId, () => session.store.setClassroomPeers(projectId, body.sessionId, {
        enabled: body.enabled,
        ...(body.engagement ? { engagement: body.engagement } : {}),
      }));
      return ok({
        session: toClassroomSessionDto(updated),
        peers: peerRuntimeState(session, body.sessionId),
      });
    }
    case 'peer-turn': {
      const input = {
        sessionId: body.sessionId,
        roleProfileId: body.roleProfileId,
        kind: body.kind,
        requestId: body.requestId,
      };
      const turn = session.store.getClassroomPeerTurnReceipt({ projectId, ...input })
        ?? withRoomTeacher(session, body.sessionId, () => {
          assertRecoveryExecution(session, body.sessionId);
          return requestPeerTurn(session, input);
        });
      return ok({
        turn,
        peers: peerRuntimeState(session, body.sessionId),
        session: toClassroomSessionDto(session.store.getClassroomSession(body.sessionId, projectId)!),
      });
    }
  }
  const exhaustive: never = body;
  return exhaustive;
});
