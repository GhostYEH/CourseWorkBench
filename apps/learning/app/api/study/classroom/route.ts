import { z } from 'zod';
import {
  StudyError,
  classroomAdvanceSchema,
  classroomAnsweredSchema,
  classroomCloseSchema,
  classroomHandbackSchema,
  classroomOpenSchema,
  classroomPlaySchema,
  explanationCreateSchema,
  explanationEditSchema,
  explanationReviewSchema,
} from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import { toClassroomSessionDto, toExplanationDto } from '../../../../lib/server/dto';
import { CLASSROOM_OWNER_LEARNER_KEY } from '../../../../lib/server/runtime-storage';

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
]);

/**
 * 读取当前课堂现场。页面访问不创建会话、不推进动作，也不补播任何卡片。
 */
export const GET = route(() => {
  const session = requireSession();
  const open = session.store.getOpenClassroomSession(session.projectId);
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
      const opened = session.store.openClassroomSession({
        projectId,
        lessonId: body.lessonId,
        stageId: body.stageId,
        learnerKey: CLASSROOM_OWNER_LEARNER_KEY,
        sceneId: body.sceneId,
      });
      return ok({ session: toClassroomSessionDto(opened) });
    }
    case 'play-next': {
      const played = session.store.playNextExplanation(projectId, body.sessionId);
      return ok({
        card: played.card,
        deduplicated: played.deduplicated,
        session: toClassroomSessionDto(played.session),
        playedIds: played.playedIds,
      });
    }
    case 'handback':
      return ok({
        session: toClassroomSessionDto(session.store.handBackToLearner(projectId, body.sessionId, body.reason)),
      });
    case 'learner-answered':
      return ok({
        session: toClassroomSessionDto(session.store.markLearnerAnswered(projectId, body.sessionId)),
      });
    case 'advance-scene':
      return ok({
        session: toClassroomSessionDto(session.store.advanceClassroomScene(projectId, body.sessionId, body.sceneId)),
      });
    case 'close':
      return ok({
        session: toClassroomSessionDto(session.store.closeClassroomSession(projectId, body.sessionId, body.status, body.reason)),
      });
  }
  throw new StudyError('INVALID_ARGUMENT', { reason: 'unknown_classroom_action' });
});
