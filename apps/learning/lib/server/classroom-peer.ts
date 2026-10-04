/**
 * AI 同学的课堂运行（PEER-01）。
 *
 * 这一层把「角色配置」变成「课堂里真的有一位同学在按规则发言」：
 *
 * - 内容必须落在**已审核**的教学材料上：`example` 绑定一张已审核讲解卡，
 *   `question`/`discussion` 引用当前场景已准入的冻结陈述。服务端不允许同学
 *   现编学科新事实——那类内容必须先走来源受控候选与审核。
 * - 权限与上限由 `assertPeerTurnAllowed` 判定，界面按钮只是交互说明。
 * - 分区写死为 `simulation`：同学发言永远不会被读成「本人完成」。
 * - 用户优先：等待本人作答或课堂结束时同学一律不发言。
 */

import { StudyError, type ClassroomPeerTurnDto, type PeerEngagement } from '@sew/study-contracts';
import { assertPeerTurnGrounded, peerTurnCeiling } from '@sew/study-domain';
import type { Session } from './service';

/** 同学发言方式。`example` 必须绑定已审核讲解卡。 */
export type PeerTurnKind = 'question' | 'discussion' | 'example';

export interface PeerTurnRequest {
  sessionId: string;
  roleProfileId: string;
  kind: PeerTurnKind;
  requestId: string;
}

const PEER_KIND_LABEL: Record<PeerTurnKind, string> = {
  question: '提问',
  discussion: '讨论',
  example: '示例',
};

/**
 * 从当前场景的可用陈述里挑一条。
 *
 * 用「已发言轮次」取模而不是随机：同一次请求重试得到同一句发言，
 * 断线重连不会因为随机数不同而多出一条。场景没有可用陈述时明确失败，
 * 而不是让同学凭空说一句没有来源的话。
 */
const pickStatement = (statementIds: readonly string[], seed: number): string => {
  if (statementIds.length === 0) {
    throw new StudyError('SOURCE_MISSING', { reason: 'peer_scene_has_no_statement' });
  }
  return statementIds[seed % statementIds.length]!;
};

/**
 * 组装一句同学发言。
 *
 * 正文里带着被引用的陈述原文，所以它确实是「关于这节课内容」的话，
 * 而不是一段与课程无关的固定占位文本。
 */
const composeText = (facts: {
  kind: PeerTurnKind;
  peerName: string;
  statementText: string;
  reviewedExampleText: string | null;
}): string => {
  const { kind, peerName, statementText, reviewedExampleText } = facts;
  if (kind === 'example') {
    // 示例只能复述已审核内容，并在正文里注明是模拟。
    return `（${peerName}·模拟示例）我按已审核的讲解复述一遍：${reviewedExampleText ?? statementText}`;
  }
  if (kind === 'question') {
    return `（${peerName}·模拟提问）关于「${statementText}」，我想确认一个边界：如果条件不满足，还能这样用吗？`;
  }
  return `（${peerName}·模拟讨论）「${statementText}」这一点，我倾向于先记结论再补推导；你有不同看法吗？`;
};

/**
 * 请求一次 AI 同学发言。
 *
 * 调用方只能指定「哪位同学、以哪种方式开口」，不能提交发言正文——
 * 正文由服务端按已审核内容组装，因此不存在客户端把未经审核的学科内容
 * 塞进课堂发言的路径。
 */
export const requestPeerTurn = (session: Session, input: PeerTurnRequest): ClassroomPeerTurnDto => session.store.transaction(() => {
  const { store, projectId } = session;
  const receipt = store.getClassroomPeerTurnReceipt({ ...input, projectId });
  if (receipt) return receipt;
  const classroom = store.getClassroomSession(input.sessionId, projectId);
  if (!classroom) throw new StudyError('NOT_FOUND', { sessionId: input.sessionId });

  const profile = store.listRoleProfiles('formal').find((item) => item.profileId === input.roleProfileId);
  if (!profile) throw new StudyError('NOT_FOUND', { roleProfileId: input.roleProfileId });
  if (profile.kind !== 'peer') throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_a_peer_role' });

  // 当前场景允许引用的陈述：与白板共用同一份判定，避免两处各放宽一点。
  // 会话挂接 stage 时必须有当前场景来源；仅未挂接课件的课堂使用整课冻结陈述。
  const sceneStatementIds = store.classroomBoardStatementIds(projectId, input.sessionId);
  const bundle = store.getEvidenceBundle(projectId, classroom.bundleId);
  if (!bundle) throw new StudyError('NOT_FOUND', { bundleId: classroom.bundleId });
  const statementById = new Map(bundle.bundle.statements.map((statement) => [statement.statementId, statement]));
  let allowedStatementIds = sceneStatementIds;
  if (!classroom.stageId) {
    const lesson = store.getLessonVersion(classroom.lessonId, classroom.lessonVersion, projectId);
    allowedStatementIds = (lesson?.statementIds ?? []).filter((id) => statementById.has(id));
  }

  const alreadySpoken = store.classroomPeerTurnCount(projectId, input.sessionId, classroom.roundIndex);
  const seed = alreadySpoken;

  let statementIds: string[];
  let reviewedExampleId: string | null = null;
  let reviewedExampleText: string | null = null;

  if (input.kind === 'example') {
    // 示例必须绑定一张**已审核**讲解卡：同学不能自己编一个例子来演示。
    const cards = store.listExplanationCards(classroom.lessonId, classroom.lessonVersion, projectId);
    const approved = cards
      .filter((card) => card.status === 'approved' && card.sceneId === classroom.currentSceneId)
      .sort((left, right) => left.position - right.position || left.explanationId.localeCompare(right.explanationId));
    const card = approved[seed % Math.max(1, approved.length)];
    if (!card) throw new StudyError('SOURCE_MISSING', { reason: 'no_reviewed_example_in_scene' });
    statementIds = card.statementIds.filter((statementId) => allowedStatementIds.includes(statementId));
    if (statementIds.length === 0) {
      throw new StudyError('SOURCE_MISSING', { reason: 'reviewed_example_outside_scene' });
    }
    reviewedExampleId = card.explanationId;
    reviewedExampleText = card.text;
  } else {
    statementIds = [pickStatement(allowedStatementIds, seed)];
  }

  const primary = statementById.get(statementIds[0]!);
  if (!primary) throw new StudyError('SOURCE_MISSING', { reason: 'peer_statement_missing_from_bundle' });

  assertPeerTurnGrounded({
    kind: input.kind,
    statementIds,
    reviewedExampleId,
    knownStatementIds: new Set(bundle.bundle.statements.map((statement) => statement.statementId)),
  });

  const text = composeText({
    kind: input.kind,
    peerName: profile.name,
    statementText: primary.text,
    reviewedExampleText,
  });

  return store.recordClassroomPeerTurn({
    projectId,
    sessionId: input.sessionId,
    roleProfileId: input.roleProfileId,
    kind: input.kind,
    text,
    statementIds,
    reviewedExampleId,
    requestId: input.requestId,
  }).turn;
});

/** 面向界面的同学状态：开关、参与度与上限，全部来自服务端判定。 */
export const peerRuntimeState = (session: Session, sessionId: string): {
  enabled: boolean;
  engagement: PeerEngagement;
  turnCeiling: number;
  turnsThisRound: number;
} => {
  const classroom = session.store.getClassroomSession(sessionId, session.projectId);
  if (!classroom) throw new StudyError('NOT_FOUND', { sessionId });
  const turnsThisRound = session.store.classroomPeerTurnCount(session.projectId, sessionId, classroom.roundIndex);
  return {
    enabled: classroom.peersEnabled,
    engagement: classroom.peersEngagement,
    turnCeiling: peerTurnCeiling(classroom.peersEngagement),
    turnsThisRound,
  };
};

export { PEER_KIND_LABEL };
