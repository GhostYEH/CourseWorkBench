import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import { StudyError, pblFrozenSchema, type PblFrozenDto } from '@sew/study-contracts';
import { assertPblDefinitionCoherent, pblDefinitionSessionId, pblHash } from '@sew/study-domain';
import type { Session } from './service';

const idFor = (raw: unknown): string => `pbl-definition-${pblHash(raw)}`;

export const pblAiMemberUid = (input: {
  projectId: string;
  lessonId: string;
  version: number;
  roleId: string;
}): string => {
  const raw = pblHash([
    'pbl-ai-member-v1',
    input.projectId,
    input.lessonId,
    input.version,
    input.roleId,
  ])
    .slice(0, 32)
    .split('');
  raw[12] = '4';
  raw[16] = (8 + (Number.parseInt(raw[16] ?? '0', 16) & 3)).toString(16);
  const hex = raw.join('');
  return `uid_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Re-read the authoritative JSON and bind its digest to its runtime envelope. */
export const readPblDefinition = (
  session: Session,
  lessonId: string,
  version: number,
): { frozen: PblFrozenDto; digest: string } | null => {
  const sessionId = pblDefinitionSessionId(lessonId, version);
  const rows = session.store.runtime.listRecords(session.projectId, sessionId);
  if (!rows.length) return null;
  const owner = session.store.runtime.getSession(session.projectId, sessionId);
  const raw = rows[0]?.payload;
  const parsed = pblFrozenSchema.safeParse(raw);
  if (
    rows.length !== 1 ||
    !parsed.success ||
    !owner ||
    owner.id !== sessionId ||
    owner.kind !== 'pblDefinition' ||
    owner.runtimeDslVersion !== RUNTIME_DSL_VERSION ||
    owner.status !== 'active' ||
    owner.stageId !== `stage_formal_${lessonId}_v${version}` ||
    owner.learnerKey !== parsed.data?.reviewedBy ||
    parsed.data.lessonId !== lessonId ||
    parsed.data.lessonVersion !== version ||
    parsed.data.projectId !== session.projectId ||
    rows[0]?.seq !== 0 ||
    rows[0]?.sessionId !== sessionId ||
    rows[0]?.id !== idFor(raw) ||
    rows[0]?.createdAt !== owner.createdAt ||
    rows[0]?.sceneId !== undefined ||
    rows[0]?.actionIndex !== undefined ||
    rows[0]?.subAnchor !== undefined
  ) {
    throw new StudyError('INTERNAL', { reason: 'invalid_frozen_pbl_definition' });
  }
  try {
    assertPblDefinitionCoherent(parsed.data.definition);
  } catch (error) {
    if (error instanceof StudyError && error.code === 'INVALID_ARGUMENT') {
      throw new StudyError('INTERNAL', { reason: 'incoherent_frozen_pbl_definition' });
    }
    throw error;
  }
  if (
    parsed.data.definition.roles.filter((role) => role.kind === 'learner').length !== 1 ||
    parsed.data.definition.roles.filter((role) => role.kind === 'learner')[0]?.memberUid !==
      session.learnerUid ||
    parsed.data.definition.roles.some(
      (role) =>
        role.kind !== 'learner' &&
        role.memberUid !==
          pblAiMemberUid({
            projectId: session.projectId,
            lessonId,
            version,
            roleId: role.id,
          }),
    )
  )
    throw new StudyError('INTERNAL', { reason: 'invalid_frozen_pbl_role_identity' });
  const lesson = session.store.getLessonVersion(lessonId, version, session.projectId);
  const bundle = lesson
    ? session.store.getEvidenceBundle(session.projectId, lesson.bundleId)
    : null;
  if (!lesson || !bundle || bundle.digest !== parsed.data.bundleDigest) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'pbl_evidence_binding_mismatch' });
  }
  const referenced = new Set([
    ...parsed.data.definition.statementIds,
    ...parsed.data.definition.tasks.flatMap((task) => task.statementIds),
    ...parsed.data.definition.milestones.flatMap((milestone) => milestone.statementIds),
  ]);
  const bundleStatements = new Set(
    bundle.bundle.statements.map((statement) => statement.statementId),
  );
  if (
    [...referenced].some(
      (statementId) =>
        !lesson.statementIds.includes(statementId) || !bundleStatements.has(statementId),
    )
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'pbl_statement_reference_mismatch' });
  }
  const knowledgeIds = bundle.bundle.statements
    .filter((statement) => referenced.has(statement.statementId))
    .map((statement) => statement.knowledgeId);
  if (!session.store.checkAdmission([...new Set(knowledgeIds)], 'formal').allowed)
    throw new StudyError('KNOWLEDGE_NOT_VERIFIED');
  return { frozen: parsed.data, digest: pblHash(raw) };
};

export const writePblDefinition = (session: Session, frozen: PblFrozenDto): void => {
  const sessionId = pblDefinitionSessionId(frozen.lessonId, frozen.lessonVersion);
  const prior = readPblDefinition(session, frozen.lessonId, frozen.lessonVersion);
  if (prior) {
    if (pblHash(prior.frozen) !== pblHash(frozen))
      throw new StudyError('VERSION_CONFLICT', { reason: 'pbl_definition_frozen' });
    return;
  }
  const now = new Date().toISOString();
  session.store.runtime.createSession(session.projectId, {
    id: sessionId,
    kind: 'pblDefinition',
    learnerKey: session.learnerUid,
    stageId: `stage_formal_${frozen.lessonId}_v${frozen.lessonVersion}`,
    runtimeDslVersion: RUNTIME_DSL_VERSION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  session.store.runtime.appendRecord(
    session.projectId,
    {
      id: idFor(frozen),
      sessionId,
      createdAt: now,
      payload: frozen,
    },
    { expectedLastSeq: null },
  );
  const saved = readPblDefinition(session, frozen.lessonId, frozen.lessonVersion);
  if (!saved || saved.digest !== pblHash(frozen))
    throw new StudyError('INTERNAL', { reason: 'pbl_definition_readback_mismatch' });
};
