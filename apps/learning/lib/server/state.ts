/**
 * 工作台总览数据装配。
 *
 * 页面与 `/api/study/state` 共用这一份实现，避免界面统计与接口统计不一致。
 * 候选计数不算知识覆盖数；模拟作答不进入本人统计。
 */

import type { WorkbenchStateDto } from '@sew/study-contracts';
import type { MaterialRow, ProposalRow } from '@sew/study-storage';
import type { Session } from './service';
import { buildKnowledgeView, type KnowledgeView } from './views';
import { DEFAULT_TEACHING_PREFERENCE } from '../preferences';
import { readGlobalPreferences, writeGlobalPreferences } from './global-preferences';
import { teachingPreferenceSchema, type PreferencesDto, type TeachingPreferenceDto } from '@sew/study-contracts';

interface WorkbenchReadData {
  materials: readonly MaterialRow[];
  proposals: readonly ProposalRow[];
  knowledge: KnowledgeView;
}

export const buildWorkbenchState = (session: Session, data?: WorkbenchReadData): WorkbenchStateDto => {
  const { store } = session;
  const project = store.getProject(session.projectId);
  const view = data?.knowledge ?? buildKnowledgeView(session);
  const knowledge = view.rows;
  const proposals = data?.proposals ?? store.listProposals();
  const materials = data?.materials ?? store.listMaterials();
  const attempts = store.countAttemptKinds();
  const confirmedPlan = store.getConfirmedPlan<{ tasks?: unknown[] }>(session.projectId);

  const blockedBySource = knowledge.filter(
    (k) => !view.admittedIds.has(k.knowledgeId) && view.blockedById.has(k.knowledgeId),
  ).length;

  return {
    project: {
      projectId: session.projectId,
      displayName: project?.displayName ?? session.displayName,
      displayPath: session.displayPath,
      generation: session.generation,
      subject: project?.subject ?? '',
      goal: project?.goal ?? '',
      examDate: project?.examDate ?? null,
      dailyMinutes: project?.dailyMinutes ?? 0,
      learningMode: project?.learningMode ?? 'beginner',
    },
    counts: {
      materials: materials.length,
      knowledgeVerified: knowledge.filter((k) => k.sourceStatus === 'verified').length,
      knowledgePending: knowledge.filter((k) => k.sourceStatus === 'pending').length,
      knowledgeInvalidated: knowledge.filter((k) => k.sourceStatus === 'invalidated').length,
      proposalsPending: proposals.filter((p) => p.status === 'pending' || p.status === 'needs_material').length,
      questions: store.listQuestions().length,
      attemptsReal: attempts.real,
      attemptsSimulation: attempts.simulation,
    },
    plan: {
      confirmedVersion: confirmedPlan?.version ?? null,
      taskCount: confirmedPlan?.payload?.tasks?.length ?? 0,
    },
    admission: {
      readyKnowledge: knowledge.length - blockedBySource,
      blockedBySource,
    },
  };
};

/** 外观与阅读属于用户级全局偏好，存用户级目录，切换项目不变。 */
export const readPreferences = (_session: Session): PreferencesDto => readGlobalPreferences();

export const writePreferences = (_session: Session, value: PreferencesDto): PreferencesDto =>
  writeGlobalPreferences(value);

export const readTeachingPreference = (session: Session): TeachingPreferenceDto => {
  const stored = session.store.readTeachingPreference<TeachingPreferenceDto>(session.projectId);
  if (stored.value === null) return { ...DEFAULT_TEACHING_PREFERENCE, version: stored.version || 1 };
  const parsed = teachingPreferenceSchema.safeParse(stored.value);
  if (!parsed.success) {
    console.warn('[preferences] persisted teaching preference failed schema validation; using defaults');
    return { ...DEFAULT_TEACHING_PREFERENCE, version: stored.version || 1 };
  }
  return { ...parsed.data, version: stored.version || 1 };
};

export const writeTeachingPreference = (
  session: Session,
  value: TeachingPreferenceDto,
): TeachingPreferenceDto => {
  const version = session.store.writeTeachingPreference(session.projectId, value);
  return { ...value, version };
};
