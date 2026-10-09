/**
 * 互动保活快照服务（OMA-045）。
 *
 * 组件把临时现场（如滑块取值）作为快照上报；服务端按 (项目, stage, 场景, 本人) 分区持久化。
 * 恢复判定用**当前文档摘要**作为组件版本：只有文档摘要一致才恢复，否则明确重置。
 * 快照不参与判分、不更新掌握；本人已提交的互动记录始终保留，不因现场重置删除。
 */

import { StudyError } from '@sew/study-contracts';
import type { InteractiveSnapshotCommand, InteractiveSnapshotStateDto } from '@sew/study-contracts';
import { decideInteractiveSnapshot } from '@sew/study-domain';
import { assertScope, type Session } from './service';

const nowIso = (): string => new Date().toISOString();

/** 当前组件版本：取该 stage 的权威文档摘要（文档一变，旧现场即失效）。 */
const widgetVersionOf = (session: Session, stageId: string, sceneId: string): string => {
  const stored = session.store.getClassroomDocument(session.projectId, stageId);
  if (!stored) throw new StudyError('NOT_FOUND', { stageId });
  const document = stored.document as { scenes?: Array<{ id?: string; type?: string }> } | null;
  if (!Array.isArray(document?.scenes))
    throw new StudyError('INTERNAL', { reason: 'snapshot_document_invalid' });
  if (!document.scenes.some((scene) => scene.id === sceneId && scene.type === 'interactive'))
    throw new StudyError('NOT_FOUND', {
      stageId,
      sceneId,
      reason: 'snapshot_interactive_scene_missing',
    });
  return stored.digest;
};

export const commandInteractiveSnapshot = (
  session: Session,
  raw: InteractiveSnapshotCommand,
): InteractiveSnapshotStateDto => {
  assertScope(raw.scope);
  if (raw.scope.projectId !== session.projectId || raw.scope.generation !== session.generation)
    throw new StudyError('PROJECT_GENERATION_STALE');
  const stageId = raw.stageId;
  const sceneId = raw.sceneId;
  const widgetVersion = widgetVersionOf(session, stageId, sceneId);
  if (raw.operation === 'read') {
    const stored = session.store.interactiveSnapshots.read(
      session.projectId,
      stageId,
      sceneId,
      session.learnerUid,
    );
    const decision = decideInteractiveSnapshot({
      currentWidgetVersion: widgetVersion,
      stored: stored
        ? { widgetVersion: stored.widgetVersion, data: stored.data, updatedAt: stored.updatedAt }
        : null,
    });
    return {
      widgetVersion,
      restored: decision.restored,
      snapshot:
        decision.restored && stored
          ? {
              stageId: stored.stageId,
              sceneId: stored.sceneId,
              widgetVersion: stored.widgetVersion,
              data: decision.data ?? {},
              updatedAt: stored.updatedAt,
            }
          : null,
      reason: decision.reason,
    };
  }
  if (raw.operation === 'clear') {
    session.store.transaction(() =>
      session.store.interactiveSnapshots.clear(
        session.projectId,
        stageId,
        sceneId,
        session.learnerUid,
      ),
    );
    return { widgetVersion, restored: false, snapshot: null, reason: 'none' };
  }
  // write：组件版本由服务端按当前文档摘要盖章，客户端不能自报版本绕过「版本变化即重置」。
  const saved = session.store.transaction(() =>
    session.store.interactiveSnapshots.write({
      projectId: session.projectId,
      stageId,
      sceneId,
      learnerUid: session.learnerUid,
      widgetVersion,
      data: raw.data,
      updatedAt: nowIso(),
    }),
  );
  return {
    widgetVersion,
    restored: true,
    snapshot: {
      stageId: saved.stageId,
      sceneId: saved.sceneId,
      widgetVersion: saved.widgetVersion,
      data: saved.data,
      updatedAt: saved.updatedAt,
    },
    reason: 'restored',
  };
};
