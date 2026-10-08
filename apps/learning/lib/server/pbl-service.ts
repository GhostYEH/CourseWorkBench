import { z } from 'zod';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import {
  StudyError,
  pblBindingSchema,
  pblCommandSchema,
  pblContributionPayloadSchema,
  pblDeliverableDraftSchema,
  pblFeedbackPayloadSchema,
  pblFrozenSchema,
  pblAssessmentPayloadSchema,
  pblRecordSchema,
  pblProjectStateSchema,
  pblSimulationStepSchemaChecked,
  pblSimulationStateSchema,
  type PblAssessmentPayloadInput,
  type PblBindingDto,
  type PblCommand,
  type PblContributionPayloadInput,
  type PblFeedbackPayloadInput,
  type PblFrozenDto,
  type PblProjectDefinitionDto,
  type PblProjectStateDto,
  type PblRecordDto,
  type PblSimulationStateDto,
  type PblSimulationStepInput,
} from '@sew/study-contracts';
import {
  assertPblAcceptanceTargetsAssessment,
  assertPblArtifactKindAllowed,
  assertPblAcknowledgesExistingContribution,
  assertPblBindingMatchesFrozen,
  assertPblCandidateGrounded,
  assertPblCommandScope,
  assertPblContributionGrounded,
  assertPblDefinitionCoherent,
  assertPblDefinitionFrozen,
  assertPblDeliverableReferences,
  assertPblFeedbackGrounded,
  assertPblOperationAllowed,
  assertPblRecordGroundedInDefinition,
  assertPblTaskOpenable,
  openPblSimulation,
  pblAcceptanceRecordFrom,
  pblAcknowledgeRecordFrom,
  pblActorTypeOfSeat,
  pblAssessmentRecordFrom,
  pblDeliverableRecordFrom,
  pblDraftFrom,
  pblEvidenceFromRecords,
  pblExistingArtifactIds,
  pblHash,
  pblLearnerRole,
  pblMilestoneEvaluations,
  pblProjectSceneId,
  publicPblProjectDefinition,
  pblReceiptFrom,
  pblAcknowledgedContributionNonces,
  pblSplitEvidence,
  pblTaskProgressRecordFrom,
  pblTaskViews,
  runPblSimulationStep,
} from '@sew/study-domain';
import type { RuntimeRecordRow } from '@sew/study-storage';
import { loadRenderableDocument } from './classroom-service';
import type { Session } from './service';
import { assertScope } from './service';
import { pblAiMemberUid, readPblDefinition, writePblDefinition } from './pbl-definition-store';

const recordSessionId = (projectId: string, uid: string, binding: PblBindingDto): string =>
  `sew-pbl-record-v1-${pblHash([projectId, uid, binding])}`;
const recordId = (payload: unknown): string => `pbl-record-${pblHash(payload)}`;
const canonicalComparisonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalComparisonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalComparisonValue(child)]),
  );
};
const comparisonHash = (value: unknown): string => pblHash(canonicalComparisonValue(value));
const draftEnvelopeSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('draft'),
    uid: z.string(),
    binding: pblBindingSchema,
    nonce: z.string(),
    intentDigest: z.string(),
    draft: pblDeliverableDraftSchema,
  })
  .strict();

type DraftEnvelope = ReturnType<typeof draftEnvelopeSchema.parse>;
type StoredPblRow = { row: RuntimeRecordRow; record?: PblRecordDto; draft?: DraftEnvelope };

const scopeOf = (session: Session, command: PblCommand): void => {
  assertScope(command.scope);
  assertPblCommandScope(command.scope, session);
};

export { pblAiMemberUid } from './pbl-definition-store';

const assertFrozenReferences = (
  session: Session,
  lessonId: string,
  version: number,
  definition: PblProjectDefinitionDto,
): string => {
  const lesson = session.store.getLessonVersion(lessonId, version, session.projectId);
  if (
    !lesson ||
    lesson.status !== 'draft' ||
    session.store.getLessonReview(lessonId, version, session.projectId)
  )
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
      reason: 'pbl_requires_unreviewed_draft',
    });
  const bundle = session.store.getEvidenceBundle(session.projectId, lesson.bundleId);
  if (!bundle || bundle.bundle.recordScope !== 'formal')
    throw new StudyError('KNOWLEDGE_NOT_VERIFIED');
  const refs = new Set<string>([
    ...definition.statementIds,
    ...definition.tasks.flatMap((task) => task.statementIds),
    ...definition.milestones.flatMap((milestone) => milestone.statementIds),
  ]);
  const source = new Map(
    bundle.bundle.statements.map((statement) => [statement.statementId, statement.knowledgeId]),
  );
  if ([...refs].some((id) => !lesson.statementIds.includes(id) || !source.has(id)))
    throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', {
      reason: 'pbl_statement_reference_mismatch',
    });
  if (
    !session.store.checkAdmission([...new Set([...refs].map((id) => source.get(id)!))], 'formal')
      .allowed
  )
    throw new StudyError('KNOWLEDGE_NOT_VERIFIED');
  return bundle.digest;
};

export const reviewPblDefinition = (
  session: Session,
  input: Extract<PblCommand, { operation: 'review' }>,
): PblFrozenDto =>
  session.store.transaction(() => {
    scopeOf(session, input);
    if (input.semanticReviewed !== true) throw new StudyError('INVALID_ARGUMENT');
    const original = input.definition;
    const learners = original.roles.filter((role) => role.kind === 'learner');
    if (
      learners.length !== 1 ||
      learners[0]?.memberUid !== session.learnerUid ||
      original.roles.some((role) => role.kind !== 'learner' && role.memberUid !== null)
    )
      throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'pbl_review_identity_mismatch' });
    const definition: PblProjectDefinitionDto = {
      ...original,
      roles: original.roles.map((role) =>
        role.kind === 'learner'
          ? { ...role, memberUid: session.learnerUid }
          : {
              ...role,
              memberUid: pblAiMemberUid({
                projectId: session.projectId,
                lessonId: input.lessonId,
                version: input.lessonVersion,
                roleId: role.id,
              }),
            },
      ),
    };
    assertPblDefinitionCoherent(definition);
    const bundleDigest = assertFrozenReferences(
      session,
      input.lessonId,
      input.lessonVersion,
      definition,
    );
    if (input.binding.definitionId !== definition.id)
      throw new StudyError('VERSION_CONFLICT', { reason: 'pbl_review_binding_mismatch' });
    const frozen = pblFrozenSchema.parse({
      version: 1,
      projectId: session.projectId,
      lessonId: input.lessonId,
      lessonVersion: input.lessonVersion,
      bundleDigest,
      reviewedBy: session.learnerUid,
      reviewNote: input.reviewNote,
      definition,
    });
    writePblDefinition(session, frozen);
    return frozen;
  });

const currentBinding = (session: Session, stageId: string, frozen: PblFrozenDto): PblBindingDto => {
  const document = loadRenderableDocument(session, stageId);
  const scenes =
    document?.document &&
    typeof document.document === 'object' &&
    Array.isArray((document.document as { scenes?: unknown }).scenes)
      ? (document.document as { scenes: unknown[] }).scenes
      : [];
  const stored = session.store.getClassroomDocument(session.projectId, stageId);
  const link = session.store.getLessonClassroomLink(frozen.lessonId, session.projectId);
  const lesson = session.store.getLessonVersion(
    frozen.lessonId,
    frozen.lessonVersion,
    session.projectId,
  );
  const scene = scenes.find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      (candidate as { type?: unknown }).type === 'pbl',
  );
  if (
    !document ||
    !stored ||
    stored.recordScope !== 'formal' ||
    stored.lessonId !== frozen.lessonId ||
    stored.digest !== document.digest ||
    !link ||
    link.status !== 'published' ||
    link.lessonVersion !== frozen.lessonVersion ||
    link.stageId !== stageId ||
    !lesson ||
    lesson.status !== 'published' ||
    !session.store.getLessonReview(frozen.lessonId, frozen.lessonVersion, session.projectId) ||
    !scene ||
    typeof scene !== 'object' ||
    (scene as { id?: unknown }).id !== pblProjectSceneId(frozen.definition.id)
  )
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
      reason: 'pbl_requires_published_bound_scene',
    });
  const binding = pblBindingSchema.parse({
    version: 1,
    stageId,
    definitionId: frozen.definition.id,
    documentDigest: document.digest,
    definitionDigest: pblHash(frozen.definition),
  });
  assertPblBindingMatchesFrozen(frozen, binding);
  return binding;
};

const pblSceneIdForStage = (session: Session, stageId: string, frozen: PblFrozenDto): string => {
  const document = loadRenderableDocument(session, stageId);
  const scenes =
    document?.document &&
    typeof document.document === 'object' &&
    Array.isArray((document.document as { scenes?: unknown }).scenes)
      ? (document.document as { scenes: unknown[] }).scenes
      : [];
  const scene = scenes.find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      (candidate as { type?: unknown }).type === 'pbl',
  );
  const id = scene && typeof scene === 'object' ? (scene as { id?: unknown }).id : null;
  if (id !== pblProjectSceneId(frozen.definition.id))
    throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING');
  return id;
};

const readStoredRows = (
  session: Session,
  binding: PblBindingDto,
  frozen: PblFrozenDto,
): StoredPblRow[] => {
  const sid = recordSessionId(session.projectId, session.learnerUid, binding);
  const owner = session.store.runtime.getSession(session.projectId, sid);
  const rows = session.store.runtime.listRecords(session.projectId, sid);
  if (!owner && rows.length)
    throw new StudyError('INTERNAL', { reason: 'pbl_records_without_owner' });
  if (
    owner &&
    (owner.id !== sid ||
      owner.kind !== 'pblRecords' ||
      owner.learnerKey !== session.learnerUid ||
      owner.stageId !== binding.stageId ||
      owner.runtimeDslVersion !== RUNTIME_DSL_VERSION ||
      owner.status !== 'active')
  )
    throw new StudyError('INTERNAL', { reason: 'invalid_pbl_record_session' });
  const seenNonces = new Map<string, string>();
  return rows.map((row, index) => {
    if (
      row.seq !== index ||
      row.sessionId !== sid ||
      row.sceneId !== undefined ||
      row.actionIndex !== undefined ||
      row.subAnchor !== undefined ||
      row.id !== recordId(row.payload)
    )
      throw new StudyError('INTERNAL', { reason: 'invalid_pbl_record_envelope' });
    const record = pblRecordSchema.safeParse(row.payload);
    if (record.success) {
      const rowUidIsOwner = record.data.uid === session.learnerUid;
      const seatId =
        record.data.kind === 'contribution' || record.data.kind === 'assessment'
          ? record.data.roleId
          : null;
      const aiSeat = seatId
        ? frozen.definition.roles.find((seat) => seat.id === seatId)
        : frozen.definition.roles.find((seat) => seat.memberUid === record.data.uid);
      const isDerivedAiRecord =
        !rowUidIsOwner &&
        !!aiSeat &&
        aiSeat.kind !== 'learner' &&
        aiSeat.memberUid === record.data.uid &&
        aiSeat.memberUid ===
          pblAiMemberUid({
            projectId: session.projectId,
            lessonId: frozen.lessonId,
            version: frozen.lessonVersion,
            roleId: aiSeat.id,
          }) &&
        (record.data.kind === 'contribution' ||
          record.data.kind === 'feedback' ||
          record.data.kind === 'assessment');
      if (
        (!rowUidIsOwner && !isDerivedAiRecord) ||
        pblHash(record.data.binding) !== pblHash(binding) ||
        record.data.createdAt !== row.createdAt
      )
        throw new StudyError('INTERNAL', { reason: 'invalid_pbl_record_binding' });
      const key = seenNonces.get(record.data.nonce);
      if (key && key !== comparisonHash(intentForRecord(record.data)))
        throw new StudyError('INTERNAL', { reason: 'pbl_nonce_collision' });
      seenNonces.set(record.data.nonce, comparisonHash(intentForRecord(record.data)));
      return { row, record: record.data };
    }
    const draft = draftEnvelopeSchema.safeParse(row.payload);
    if (
      !draft.success ||
      draft.data.uid !== session.learnerUid ||
      draft.data.draft.uid !== session.learnerUid ||
      draft.data.nonce !== draft.data.draft.nonce ||
      pblHash(draft.data.binding) !== pblHash(binding) ||
      pblHash(draft.data.draft.binding) !== pblHash(binding) ||
      draft.data.draft.updatedAt !== row.createdAt
    )
      throw new StudyError('INTERNAL', { reason: 'invalid_pbl_record_payload' });
    const key = seenNonces.get(draft.data.nonce);
    if (key && key !== draft.data.intentDigest)
      throw new StudyError('INTERNAL', { reason: 'pbl_nonce_collision' });
    seenNonces.set(draft.data.nonce, draft.data.intentDigest);
    return { row, draft: draft.data };
  });
};

const validateAssetRefs = (
  session: Session,
  binding: PblBindingDto,
  sceneId: string,
  assetRefs: string[],
): void => {
  const assets = new Map(
    session.store.listClassroomAssets(session.projectId).map((asset) => [asset.assetId, asset]),
  );
  const bindings = session.store.listClassroomAssetBindings(session.projectId, binding.stageId);
  for (const assetId of assetRefs) {
    const asset = assets.get(assetId);
    if (
      !asset ||
      asset.recordScope !== 'formal' ||
      !bindings.some(
        (entry) =>
          entry.recordScope === 'formal' && entry.sceneId === sceneId && entry.assetId === assetId,
      )
    )
      throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', {
        reason: 'pbl_asset_not_bound_to_scene',
        assetId,
      });
  }
};

const buildProjectState = (
  session: Session,
  frozen: PblFrozenDto,
  binding: PblBindingDto,
  rows: StoredPblRow[],
  deduplicated = false,
): PblProjectStateDto => {
  const records = rows.flatMap((item) => (item.record ? [item.record] : []));
  const checked = pblEvidenceFromRecords(frozen.definition, records, binding);
  const prefix: PblRecordDto[] = [];
  for (const record of checked.records) {
    const evidence = pblEvidenceFromRecords(
      frozen.definition,
      [...prefix, record],
      binding,
    ).evidence;
    assertPblRecordGroundedInDefinition(frozen.definition, record);
    if (record.kind === 'contribution') assertPblContributionGrounded(record, evidence);
    if (record.kind === 'feedback') assertPblFeedbackGrounded(record, evidence);
    if (record.kind === 'assessment')
      assertPblCandidateGrounded(frozen.definition, record, pblExistingArtifactIds(evidence));
    if (record.kind === 'acknowledge')
      assertPblAcknowledgesExistingContribution(record.contributionNonce, evidence);
    if (record.kind === 'acceptance') assertPblAcceptanceTargetsAssessment(record, evidence);
    if (record.kind === 'task_progress') {
      const derivedStatus = pblTaskViews(frozen.definition, evidence, null).find(
        (view) => view.taskId === record.taskId,
      )?.status;
      if (derivedStatus !== record.derivedStatus)
        throw new StudyError('INTERNAL', { reason: 'pbl_task_derived_status_mismatch' });
    }
    prefix.push(record);
  }
  const draftsByTask = new Map<string, PblProjectStateDto['ownDraft']>();
  for (const item of rows) {
    if (item.draft) draftsByTask.set(item.draft.draft.taskId, item.draft.draft);
  }
  const drafts = [...draftsByTask.values()];
  const draft = rows.flatMap((item) => (item.draft ? [item.draft.draft] : [])).at(-1) ?? null;
  const tasks = pblTaskViews(frozen.definition, checked.evidence, null).map((task) => ({
    ...task,
    ownDraftTitle: draftsByTask.get(task.taskId)?.artifactTitle ?? null,
  }));
  const evidenceSets = pblSplitEvidence(checked.evidence);
  const acknowledgedContributionNonces = [
    ...pblAcknowledgedContributionNonces(evidenceSets),
  ].sort();
  const state = {
    definition: publicPblProjectDefinition(frozen.definition),
    binding,
    viewerUid: session.learnerUid,
    viewerIsMember: frozen.definition.roles.some((role) => role.memberUid === session.learnerUid),
    tasks,
    milestones: pblMilestoneEvaluations(frozen.definition, checked.evidence),
    ownDraft: draft,
    ownDrafts: drafts,
    acknowledgedContributionNonces,
    ownSubmissions: checked.records
      .filter((record) => record.kind === 'deliverable')
      .map(pblReceiptFrom),
    contributions: checked.records
      .filter((record) => record.kind === 'contribution')
      .map(pblReceiptFrom),
    feedback: checked.records.filter((record) => record.kind === 'feedback').map(pblReceiptFrom),
    assessments: checked.records
      .filter((record) => record.kind === 'assessment')
      .map(pblReceiptFrom),
    count: checked.records.filter((record) => record.kind === 'deliverable').length,
    deduplicated,
  };
  return pblProjectStateSchema.parse(state);
};

export const readPblContext = (
  session: Session,
  stageId: string,
  definitionId: string,
): {
  frozen: PblFrozenDto;
  binding: PblBindingDto;
  records: PblRecordDto[];
  state: PblProjectStateDto;
} => {
  assertScope({ projectId: session.projectId, generation: session.generation });
  const document = loadRenderableDocument(session, stageId);
  const stored = session.store.getClassroomDocument(session.projectId, stageId);
  if (!document || !stored || stored.recordScope !== 'formal')
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED');
  const link = session.store.getLessonClassroomLink(stored.lessonId, session.projectId);
  const frozenResult = link
    ? readPblDefinition(session, stored.lessonId, link.lessonVersion)
    : null;
  if (!frozenResult || frozenResult.frozen.definition.id !== definitionId)
    throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', { reason: 'pbl_definition_not_found' });
  const frozen = assertPblDefinitionFrozen(frozenResult.frozen);
  const binding = currentBinding(session, stageId, frozen);
  const rows = readStoredRows(session, binding, frozen);
  const state = buildProjectState(session, frozen, binding, rows);
  return {
    frozen,
    binding,
    records: rows.flatMap((item) => (item.record ? [item.record] : [])),
    state,
  };
};

export const loadPblProject = (
  session: Session,
  stageId: string,
  definitionId: string,
): PblProjectStateDto => readPblContext(session, stageId, definitionId).state;

const findOpenRole = (rows: StoredPblRow[], taskId: string): string | null => {
  const open = rows
    .flatMap((item) =>
      item.record?.kind === 'task_progress' &&
      item.record.intent === 'open' &&
      item.record.taskId === taskId
        ? [item.record]
        : [],
    )
    .at(-1);
  return open?.roleId ?? null;
};

const commandIntent = (
  command: Exclude<
    PblCommand,
    { operation: 'review' | 'simulate' | 'requestFeedback' | 'contribute' | 'feedback' | 'assess' }
  >,
): unknown => {
  if (command.operation === 'task')
    return {
      operation: command.operation,
      binding: command.binding,
      actorUid: command.actorUid,
      intent: command.intent,
      taskId: command.taskId,
      roleId: command.intent === 'open' ? command.roleId : null,
      reportedStatus: command.reportedStatus,
      report: command.report,
      nonce: command.nonce,
    };
  const { scope: _ignored, ...rest } = command;
  return rest;
};

const recordIntent = (record: PblRecordDto): unknown => {
  if (record.kind === 'deliverable')
    return {
      operation: 'submit',
      binding: record.binding,
      actorUid: record.uid,
      deliverable: {
        taskId: record.taskId,
        milestoneId: record.milestoneId,
        artifactKind: record.artifactKind,
        artifactTitle: record.artifactTitle,
        artifactText: record.artifactText,
        assetRefs: record.assetRefs,
        goalIds: record.goalIds,
      },
      nonce: record.nonce,
    };
  if (record.kind === 'task_progress')
    return {
      operation: 'task',
      binding: record.binding,
      actorUid: record.uid,
      intent: record.intent,
      taskId: record.taskId,
      roleId: record.intent === 'open' ? record.roleId : null,
      reportedStatus: record.reportedStatus,
      report: record.report,
      nonce: record.nonce,
    };
  if (record.kind === 'acknowledge')
    return {
      operation: 'acknowledge',
      binding: record.binding,
      actorUid: record.uid,
      contributionNonce: record.contributionNonce,
      note: record.note,
      nonce: record.nonce,
    };
  if (record.kind === 'acceptance')
    return {
      operation: 'acceptEvaluation',
      binding: record.binding,
      actorUid: record.uid,
      assessmentNonce: record.assessmentNonce,
      acceptedCandidateIds: record.acceptedCandidateIds,
      nonce: record.nonce,
    };
  return null;
};

const appendPbl = (
  session: Session,
  binding: PblBindingDto,
  payload: unknown,
  expectedLastSeq: number | null,
): RuntimeRecordRow => {
  const sid = recordSessionId(session.projectId, session.learnerUid, binding);
  const parsedRecord = pblRecordSchema.safeParse(payload);
  const parsedDraft = draftEnvelopeSchema.safeParse(payload);
  if (parsedRecord.success) {
    const now = parsedRecord.data.createdAt;
    return appendPblNormalized(session, binding, sid, parsedRecord.data, now, expectedLastSeq);
  }
  if (parsedDraft.success) {
    const now = parsedDraft.data.draft.updatedAt;
    return appendPblNormalized(session, binding, sid, parsedDraft.data, now, expectedLastSeq);
  }
  throw new StudyError('INTERNAL', { reason: 'invalid_pbl_append_payload' });
};

const appendPblNormalized = (
  session: Session,
  binding: PblBindingDto,
  sid: string,
  storedPayload: unknown,
  now: string,
  expectedLastSeq: number | null,
): RuntimeRecordRow => {
  const owner = session.store.runtime.getSession(session.projectId, sid);
  if (
    owner &&
    (owner.kind !== 'pblRecords' ||
      owner.learnerKey !== session.learnerUid ||
      owner.stageId !== binding.stageId ||
      owner.runtimeDslVersion !== RUNTIME_DSL_VERSION ||
      owner.status !== 'active')
  )
    throw new StudyError('INTERNAL', { reason: 'pbl_record_partition_conflict' });
  if (!owner)
    session.store.runtime.createSession(session.projectId, {
      id: sid,
      kind: 'pblRecords',
      learnerKey: session.learnerUid,
      stageId: binding.stageId,
      runtimeDslVersion: RUNTIME_DSL_VERSION,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  return session.store.runtime.appendRecord(
    session.projectId,
    {
      id: recordId(storedPayload),
      sessionId: sid,
      createdAt: now,
      payload: storedPayload,
    },
    { expectedLastSeq },
  );
};

const reviewRetry = (
  session: Session,
  input: Extract<PblCommand, { operation: 'review' }>,
): PblFrozenDto => reviewPblDefinition(session, input);

export const commandPblProject = (
  session: Session,
  raw: PblCommand,
): PblProjectStateDto | PblFrozenDto | PblSimulationStateDto => {
  const parsed = pblCommandSchema.safeParse(raw);
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  const command = parsed.data;
  scopeOf(session, command);
  if (command.operation === 'review') return reviewRetry(session, command);
  if (command.operation === 'requestFeedback')
    throw new StudyError(
      'INVALID_ARGUMENT',
      { reason: 'pbl_mentor_service_not_connected' },
      '导师反馈服务尚未接入。',
    );
  if (
    command.operation === 'contribute' ||
    command.operation === 'feedback' ||
    command.operation === 'assess'
  )
    throw new StudyError('ROLE_PERMISSION_DENIED', {
      reason: 'ai_record_requires_server_model_gateway',
    });
  if (command.operation === 'simulate') {
    if (command.viewerUid !== null && command.viewerUid !== session.learnerUid)
      throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'simulation_viewer_mismatch' });
    const context = readPblContext(session, command.binding.stageId, command.binding.definitionId);
    if (pblHash(context.binding) !== pblHash(command.binding))
      throw new StudyError('VERSION_CONFLICT');
    return openPblSimulation(context.frozen, context.binding, { maxSteps: command.maxSteps });
  }
  return session.store.transaction(() => {
    const context = readPblContext(session, command.binding.stageId, command.binding.definitionId);
    if (pblHash(context.binding) !== pblHash(command.binding))
      throw new StudyError('VERSION_CONFLICT');
    const { frozen, binding } = context;
    const learnerRole = pblLearnerRole(frozen.definition, session.learnerUid);
    if ('actorUid' in command && command.actorUid !== session.learnerUid)
      throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'pbl_actor_mismatch' });
    const rows = readStoredRows(session, binding, frozen);
    const intent = pblHash(commandIntent(command));
    const previous = rows.find(
      (item) => item.record?.nonce === command.nonce || item.draft?.nonce === command.nonce,
    );
    if (previous) {
      const same = previous.draft
        ? command.operation === 'draft' && previous.draft.intentDigest === intent
        : command.operation !== 'draft' &&
          previous.record !== undefined &&
          comparisonHash(recordIntent(previous.record)) === comparisonHash(commandIntent(command));
      if (!same) throw new StudyError('VERSION_CONFLICT', { reason: 'pbl_nonce_reused' });
      return buildProjectState(session, frozen, binding, rows, true);
    }
    const now = new Date().toISOString();
    if (command.operation === 'draft') {
      assertPblOperationAllowed(learnerRole, 'submit');
      if (command.actorUid !== session.learnerUid) throw new StudyError('ROLE_PERMISSION_DENIED');
      const task = assertPblTaskOpenable(frozen.definition, command.draft.taskId, learnerRole.id);
      if (findOpenRole(rows, task.id) !== learnerRole.id)
        throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'pbl_task_not_opened_by_member' });
      assertPblArtifactKindAllowed(task, command.draft.artifactKind);
      assertPblDeliverableReferences(frozen.definition, command.draft);
      validateAssetRefs(
        session,
        binding,
        pblSceneIdForStage(session, binding.stageId, frozen),
        command.draft.assetRefs,
      );
      const draft = pblDraftFrom(command, {
        uid: session.learnerUid,
        createdAt: now,
        role: learnerRole,
      });
      const payload = {
        version: 1,
        kind: 'draft',
        uid: session.learnerUid,
        binding,
        nonce: command.nonce,
        intentDigest: intent,
        draft,
      };
      appendPbl(session, binding, payload, rows.length ? rows.at(-1)!.row.seq : null);
    } else {
      const record = buildRecord(session, frozen, binding, command, rows);
      if (record.kind === 'deliverable')
        validateAssetRefs(
          session,
          binding,
          pblSceneIdForStage(session, binding.stageId, frozen),
          record.assetRefs,
        );
      assertPblRecordGroundedInDefinition(frozen.definition, record);
      const { evidence } = pblEvidenceFromRecords(
        frozen.definition,
        [...context.records, record],
        binding,
      );
      const recordEvidence = evidence.at(-1)!;
      // All grounds and task/seat permissions are checked by the shared domain functions.
      if (record.kind === 'deliverable') {
        const opened = findOpenRole(rows, record.taskId);
        if (opened !== learnerRole.id)
          throw new StudyError('ROLE_PERMISSION_DENIED', {
            reason: 'pbl_task_not_opened_by_member',
          });
      }
      if (record.kind === 'contribution') assertPblContributionGrounded(record, evidence);
      if (record.kind === 'feedback') assertPblFeedbackGrounded(record, evidence);
      if (record.kind === 'assessment')
        assertPblCandidateGrounded(frozen.definition, record, pblExistingArtifactIds(evidence));
      if (record.kind === 'acknowledge')
        assertPblAcknowledgesExistingContribution(record.contributionNonce, evidence);
      if (record.kind === 'acceptance') assertPblAcceptanceTargetsAssessment(record, evidence);
      void recordEvidence;
      appendPbl(session, binding, record, rows.length ? rows.at(-1)!.row.seq : null);
    }
    const saved = readStoredRows(session, binding, frozen);
    if (saved.length !== rows.length + 1)
      throw new StudyError('INTERNAL', { reason: 'pbl_record_readback_count' });
    return buildProjectState(session, frozen, binding, saved);
  });
};

const buildRecord = (
  session: Session,
  frozen: PblFrozenDto,
  binding: PblBindingDto,
  command: Exclude<
    PblCommand,
    {
      operation:
        'review' | 'simulate' | 'requestFeedback' | 'contribute' | 'feedback' | 'assess' | 'draft';
    }
  >,
  rows: StoredPblRow[],
): PblRecordDto => {
  const role = pblLearnerRole(frozen.definition, session.learnerUid);
  const facts = { uid: session.learnerUid, createdAt: new Date().toISOString(), role };
  const bindingCommand = { ...command, binding } as typeof command;
  switch (command.operation) {
    case 'submit': {
      assertPblOperationAllowed(role, 'submit');
      if (command.actorUid !== session.learnerUid) throw new StudyError('ROLE_PERMISSION_DENIED');
      const task = assertPblTaskOpenable(frozen.definition, command.deliverable.taskId, role.id);
      assertPblArtifactKindAllowed(task, command.deliverable.artifactKind);
      assertPblDeliverableReferences(frozen.definition, command.deliverable);
      return pblDeliverableRecordFrom(
        bindingCommand as Extract<PblCommand, { operation: 'submit' }>,
        facts,
      );
    }
    case 'task': {
      assertPblOperationAllowed(role, command.intent);
      if (command.actorUid !== session.learnerUid) throw new StudyError('ROLE_PERMISSION_DENIED');
      const task = assertPblTaskOpenable(
        frozen.definition,
        command.taskId,
        command.intent === 'open' ? (command.roleId ?? '') : role.id,
      );
      const opened = findOpenRole(rows, task.id);
      if (command.intent === 'open' && opened)
        throw new StudyError('VERSION_CONFLICT', { reason: 'pbl_task_already_opened' });
      if (command.intent === 'update' && !opened)
        throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'pbl_task_not_open' });
      const base = pblTaskProgressRecordFrom(
        bindingCommand as Extract<PblCommand, { operation: 'task' }>,
        facts,
        'available',
      );
      const taskRows = rows.flatMap((item) =>
        item.record?.kind === 'task_progress' && item.record.taskId === task.id
          ? [item.record]
          : [],
      );
      const normalized =
        command.intent === 'update'
          ? {
              ...base,
              roleId: taskRows.find((record) => record.intent === 'open')?.roleId ?? role.id,
            }
          : base;
      const priorRecords = rows.flatMap((item) => (item.record ? [item.record] : []));
      const projected = pblEvidenceFromRecords(
        frozen.definition,
        [...priorRecords, normalized],
        binding,
      ).evidence;
      const derivedStatus =
        pblTaskViews(frozen.definition, projected, null).find((view) => view.taskId === task.id)
          ?.status ?? 'available';
      return { ...normalized, derivedStatus };
    }
    case 'acknowledge': {
      assertPblOperationAllowed(role, 'acknowledge');
      if (command.actorUid !== session.learnerUid) throw new StudyError('ROLE_PERMISSION_DENIED');
      return pblAcknowledgeRecordFrom(
        bindingCommand as Extract<PblCommand, { operation: 'acknowledge' }>,
        facts,
      );
    }
    case 'acceptEvaluation': {
      assertPblOperationAllowed(role, 'acceptEvaluation');
      if (command.actorUid !== session.learnerUid) throw new StudyError('ROLE_PERMISSION_DENIED');
      const candidates = rows.flatMap((item) =>
        item.record?.kind === 'assessment' ? [item.record] : [],
      );
      const target = candidates.find((record) => record.nonce === command.assessmentNonce);
      if (!target) throw new StudyError('NOT_FOUND', { reason: 'pbl_assessment_not_found' });
      return pblAcceptanceRecordFrom(
        bindingCommand as Extract<PblCommand, { operation: 'acceptEvaluation' }>,
        facts,
        target,
      );
    }
    default:
      throw new StudyError('ROLE_PERMISSION_DENIED');
  }
};

export const savePblGeneratedRecord = (
  session: Session,
  input: {
    binding: PblBindingDto;
    actorUid: string;
    nonce: string;
    roleId: string;
    payload:
      | { kind: 'feedback'; feedback: PblFeedbackPayloadInput }
      | { kind: 'assessment'; assessment: PblAssessmentPayloadInput }
      | { kind: 'contribution'; contribution: PblContributionPayloadInput };
  },
): PblProjectStateDto =>
  session.store.transaction(() => {
    assertScope({ projectId: session.projectId, generation: session.generation });
    if (input.actorUid !== session.learnerUid)
      throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'pbl_gateway_owner_mismatch' });
    const payload =
      input.payload.kind === 'contribution'
        ? {
            kind: 'contribution' as const,
            contribution: pblContributionPayloadSchema.parse(input.payload.contribution),
          }
        : input.payload.kind === 'feedback'
          ? {
              kind: 'feedback' as const,
              feedback: pblFeedbackPayloadSchema.parse(input.payload.feedback),
            }
          : {
              kind: 'assessment' as const,
              assessment: pblAssessmentPayloadSchema.parse(input.payload.assessment),
            };
    const checkedInput = { ...input, payload };
    const context = readPblContext(session, input.binding.stageId, input.binding.definitionId);
    if (pblHash(context.binding) !== pblHash(input.binding))
      throw new StudyError('VERSION_CONFLICT');
    const role = frozenRole(context.frozen, input.roleId);
    if (
      role.kind === 'learner' ||
      !role.memberUid ||
      pblAiMemberUid({
        projectId: session.projectId,
        lessonId: context.frozen.lessonId,
        version: context.frozen.lessonVersion,
        roleId: role.id,
      }) !== role.memberUid
    )
      throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'pbl_ai_seat_not_server_derived' });
    const records = context.records;
    const rows = readStoredRows(session, context.binding, context.frozen);
    const evidence = pblEvidenceFromRecords(
      context.frozen.definition,
      records,
      context.binding,
    ).evidence;
    const existing = records.find((record) => record.nonce === input.nonce);
    if (existing) {
      if (
        existing.uid !== role.memberUid ||
        comparisonHash(intentForRecord(existing)) !== comparisonHash(generatedIntent(checkedInput))
      )
        throw new StudyError('VERSION_CONFLICT', { reason: 'pbl_nonce_reused' });
      return buildProjectState(session, context.frozen, context.binding, rows, true);
    }
    const common = {
      version: 1 as const,
      uid: role.memberUid,
      recordScope: 'formal' as const,
      binding: context.binding,
      createdAt: new Date().toISOString(),
      nonce: input.nonce,
    };
    let record: PblRecordDto;
    if (payload.kind === 'contribution') {
      assertPblOperationAllowed(role, 'contribute');
      if (payload.contribution.roleId !== input.roleId)
        throw new StudyError('ROLE_PERMISSION_DENIED');
      assertPblContributionGrounded(payload.contribution, evidence);
      record = pblRecordSchema.parse({
        ...common,
        kind: 'contribution',
        actorType: pblActorTypeOfSeat(role.kind),
        ...payload.contribution,
        acknowledgedByUid: null,
        acknowledgedAt: null,
      });
    } else if (payload.kind === 'feedback') {
      assertPblOperationAllowed(role, 'feedback');
      assertPblFeedbackGrounded(payload.feedback, evidence);
      record = pblRecordSchema.parse({
        ...common,
        kind: 'feedback',
        actorType: pblActorTypeOfSeat(role.kind),
        ...payload.feedback,
      });
    } else {
      assertPblOperationAllowed(role, 'assess');
      if (payload.assessment.roleId !== null && payload.assessment.roleId !== role.id)
        throw new StudyError('ROLE_PERMISSION_DENIED');
      assertPblCandidateGrounded(
        context.frozen.definition,
        payload.assessment,
        pblExistingArtifactIds(evidence),
      );
      record = pblAssessmentRecordFrom(
        {
          scope: { projectId: session.projectId, generation: session.generation },
          binding: context.binding,
          operation: 'assess',
          actorUid: session.learnerUid,
          assessment: payload.assessment,
          nonce: input.nonce,
        },
        { uid: role.memberUid, createdAt: common.createdAt, role },
      );
    }
    record = pblRecordSchema.parse(record);
    assertPblRecordGroundedInDefinition(context.frozen.definition, record);
    appendPbl(session, context.binding, record, rows.length ? rows.at(-1)!.row.seq : null);
    const saved = readStoredRows(session, context.binding, context.frozen);
    if (
      saved.length !== rows.length + 1 ||
      saved.at(-1)?.record?.nonce !== input.nonce ||
      pblHash(saved.at(-1)?.record) !== pblHash(record)
    )
      throw new StudyError('INTERNAL', { reason: 'pbl_ai_record_readback_mismatch' });
    return buildProjectState(session, context.frozen, context.binding, saved);
  });

const frozenRole = (frozen: PblFrozenDto, roleId: string) => {
  const role = frozen.definition.roles.find((candidate) => candidate.id === roleId);
  if (!role) throw new StudyError('NOT_FOUND', { reason: 'pbl_role_not_found' });
  return role;
};

const intentForRecord = (record: PblRecordDto): unknown => {
  const intent: Record<string, unknown> = { ...record };
  for (const key of [
    'version',
    'uid',
    'recordScope',
    'binding',
    'createdAt',
    'nonce',
    'actorType',
    'acknowledgedByUid',
    'acknowledgedAt',
  ])
    delete intent[key];
  return intent;
};

const generatedIntent = (input: Parameters<typeof savePblGeneratedRecord>[1]): unknown => {
  if (input.payload.kind === 'contribution')
    return { kind: 'contribution', ...input.payload.contribution };
  if (input.payload.kind === 'feedback') return { kind: 'feedback', ...input.payload.feedback };
  if (input.payload.kind === 'assessment')
    return {
      kind: 'assessment',
      ...input.payload.assessment,
      roleId: input.payload.assessment.roleId ?? input.roleId,
    };
  return null;
};

export const simulatePbl = (
  session: Session,
  input: {
    scope: { projectId: string; generation: number };
    binding: PblBindingDto;
    steps: PblSimulationStepInput[];
    maxSteps: number;
  },
): PblSimulationStateDto => {
  assertScope(input.scope);
  assertPblCommandScope(input.scope, session);
  if (input.steps.length > 50 || input.maxSteps < 1 || input.maxSteps > 50)
    throw new StudyError('INVALID_ARGUMENT');
  const binding = pblBindingSchema.parse(input.binding);
  const context = readPblContext(session, binding.stageId, binding.definitionId);
  if (pblHash(context.binding) !== pblHash(binding)) throw new StudyError('VERSION_CONFLICT');
  const role = pblLearnerRole(context.frozen.definition, session.learnerUid);
  let state = openPblSimulation(context.frozen, binding, { maxSteps: input.maxSteps });
  const seen = new Map<string, string>();
  for (const raw of input.steps) {
    const checked = pblSimulationStepSchemaChecked.safeParse(raw);
    if (
      !checked.success ||
      raw.actorUid !== session.learnerUid ||
      raw.scope.projectId !== input.scope.projectId ||
      raw.scope.generation !== input.scope.generation ||
      pblHash(raw.binding) !== pblHash(binding) ||
      (raw.roleId !== null && raw.roleId !== role.id) ||
      ['contribute', 'feedback', 'assess', 'requestFeedback'].includes(raw.operation)
    )
      throw new StudyError('ROLE_PERMISSION_DENIED', {
        reason: 'pbl_simulation_step_not_self_learner',
      });
    const stepHash = pblHash(raw);
    const prior = seen.get(raw.nonce);
    if (prior) {
      if (prior !== stepHash)
        throw new StudyError('VERSION_CONFLICT', { reason: 'pbl_simulation_nonce_reused' });
      continue;
    }
    seen.set(raw.nonce, stepHash);
    if (
      (raw.operation === 'update' || raw.operation === 'submit') &&
      !state.steps.some(
        (step) =>
          step.taskId === raw.taskId &&
          step.operation === 'open' &&
          step.uid === session.learnerUid,
      )
    )
      throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'pbl_simulation_task_not_open' });
    const result = runPblSimulationStep(state, checked.data, {
      definition: context.frozen.definition,
      role,
      binding,
    });
    state = result.state;
  }
  return pblSimulationStateSchema.parse(state);
};
