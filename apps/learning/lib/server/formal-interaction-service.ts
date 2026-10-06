import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import {
  StudyError,
  formalInteractionCommandSchema,
  formalInteractionRecordSchema,
  type FormalInteractionCommand,
  type FormalInteractionStateDto,
} from '@sew/study-contracts';
import { assertScope, type Session } from './service';
import { loadRenderableDocument } from './classroom-service';
import {
  formalInteractionObservationSessionId,
  orderingMatches,
  parameterResult,
  publicFormalInteractionDefinition,
} from '@sew/study-domain';
import {
  formalInteractionHash as hash,
  formalInteractionSceneId,
  readFormalInteractionDefinitions,
  reviewFormalInteractionDefinitions,
} from './formal-interaction-definition-store';

/**
 * 预测与实测是否一致。
 *
 * 参数值是十进制小数，`a*x+intercept` 会有浮点误差，因此按容差比较而不是 `===`。
 * 只用于记录「这次预测对不对」，**不更新掌握状态**。
 */
const PREDICTION_TOLERANCE = 1e-9;
const predictionMatches = (prediction: number | null, actual: number): boolean | null =>
  prediction === null ? null : Math.abs(prediction - actual) <= PREDICTION_TOLERANCE;

export const loadFormalInteraction = (
  session: Session,
  stageId: string,
  sceneId: string,
): FormalInteractionStateDto => {
  assertScope({ projectId: session.projectId, generation: session.generation });
  const document = loadRenderableDocument(session, stageId);
  const stored = session.store.getClassroomDocument(session.projectId, stageId);
  if (!document || stored?.recordScope !== 'formal')
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED');
  const link = session.store.getLessonClassroomLink(document.lessonId, session.projectId);
  if (!link) throw new StudyError('NOT_FOUND');
  const definitions = readFormalInteractionDefinitions(
    session,
    document.lessonId,
    link.lessonVersion,
  );
  const definition = definitions?.frozen.definitions.find(
    (d) => formalInteractionSceneId(d.id) === sceneId,
  );
  if (!definition || !definitions) throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING');
  // 摘要取「原始存储内容」的哈希，不用 schema 解析结果——否则以后加字段会让历史观察分区漂移。
  const binding = {
    version: 1 as const,
    stageId,
    sceneId,
    documentDigest: document.digest,
    definitionDigest: definitions.digest,
  };
  const sessionId = formalInteractionObservationSessionId(
    session.projectId,
    session.learnerUid,
    binding,
  );
  const owner = session.store.runtime.getSession(session.projectId, sessionId);
  if (
    owner &&
    (owner.kind !== 'formalInteractionObservation' ||
      owner.learnerKey !== session.learnerUid ||
      owner.stageId !== stageId ||
      owner.runtimeDslVersion !== RUNTIME_DSL_VERSION ||
      owner.status !== 'active')
  )
    throw new StudyError('INTERNAL');
  const records = session.store.runtime
    .listRecords(session.projectId, sessionId)
    .map((record, index) => {
      const parsed = formalInteractionRecordSchema.safeParse(record.payload);
      // 同上：记录 id 用原始 payload 校验，缺新字段（predictionMatched/prediction）的旧记录仍可读。
      if (
        !parsed.success ||
        record.seq !== index ||
        record.sceneId !== sceneId ||
        record.actionIndex !== undefined ||
        record.subAnchor !== undefined ||
        parsed.data.uid !== session.learnerUid ||
        hash(parsed.data.binding) !== hash(binding) ||
        record.id !== `formal-observation-${hash(record.payload)}`
      )
        throw new StudyError('INTERNAL', { reason: 'invalid_formal_interaction_record' });
      const values = parsed.data.values;
      let expected: string | number | null = null;
      let expectedPrediction: boolean | null = null;
      if (definition.kind === 'parameter' && values.kind === 'parameter') {
        const steps = (values.a - definition.min) / definition.step;
        if (
          values.a < definition.min ||
          values.a > definition.max ||
          Math.abs(steps - Math.round(steps)) > 1e-7
        )
          throw new StudyError('INTERNAL');
        if (parsed.data.mode === 'submit') {
          expected = parameterResult(definition.formula, {
            a: values.a,
            x: values.x,
            intercept: definition.intercept,
          });
          expectedPrediction = predictionMatches(values.prediction, expected);
          const rawValues = (record.payload as { values?: Record<string, unknown> }).values;
          if (
            definition.predictionRequired &&
            rawValues &&
            Object.hasOwn(rawValues, 'prediction') &&
            values.prediction === null
          ) {
            throw new StudyError('INTERNAL', { reason: 'formal_interaction_prediction_missing' });
          }
        }
      } else if (definition.kind === 'concept_relation' && values.kind === 'concept_relation') {
        const edge = definition.edges.find((e) => e.id === values.edgeId);
        if (!edge || !definition.nodes.some((n) => n.id === values.to))
          throw new StudyError('INTERNAL');
        if (parsed.data.mode === 'submit')
          expected = edge.to === values.to ? '关系核验一致' : '关系核验不一致，请对照来源重试';
      } else if (definition.kind === 'ordering' && values.kind === 'ordering') {
        // 排序核验：只由服务端用冻结定义里的 `correctOrder` 判定，客户端不能自报结果。
        const itemIds = definition.items.map((item) => item.id);
        const matched = orderingMatches(values.order, definition.correctOrder, itemIds);
        if (matched === null)
          throw new StudyError('INTERNAL', { reason: 'formal_interaction_order_invalid' });
        if (parsed.data.mode === 'submit')
          expected = matched ? '排序核验一致' : '排序核验不一致，请对照来源重试';
      } else throw new StudyError('INTERNAL');
      if (parsed.data.result !== expected)
        throw new StudyError('INTERNAL', { reason: 'formal_interaction_result_mismatch' });
      if (parsed.data.predictionMatched !== expectedPrediction)
        throw new StudyError('INTERNAL', { reason: 'formal_interaction_prediction_mismatch' });
      return { id: record.id, createdAt: record.createdAt, payload: parsed.data };
    });
  const submissions = records.filter((r) => r.payload.mode === 'submit');
  const publicDefinition = publicFormalInteractionDefinition(definition);
  return {
    definition: publicDefinition,
    binding,
    draft: records.filter((r) => r.payload.mode === 'draft').at(-1) ?? null,
    lastSubmission: submissions.at(-1) ?? null,
    count: submissions.length,
    deduplicated: false,
  };
};
export const commandFormalInteraction = (session: Session, raw: FormalInteractionCommand) => {
  const checked = formalInteractionCommandSchema.safeParse(raw);
  if (!checked.success) throw new StudyError('INVALID_ARGUMENT');
  const input = checked.data;
  assertScope(input.scope);
  if (input.scope.projectId !== session.projectId || input.scope.generation !== session.generation)
    throw new StudyError('PROJECT_GENERATION_STALE');
  if (input.operation === 'review') return reviewFormalInteractionDefinitions(session, input);
  return session.store.transaction(() => {
    const state = loadFormalInteraction(session, input.binding.stageId, input.binding.sceneId);
    if (hash(state.binding) !== hash(input.binding))
      throw new StudyError('VERSION_CONFLICT', { reason: 'interaction_binding_stale' });
    const document = session.store.getClassroomDocument(session.projectId, input.binding.stageId)!;
    const link = session.store.getLessonClassroomLink(document.lessonId, session.projectId)!;
    const frozen = readFormalInteractionDefinitions(
      session,
      document.lessonId,
      link.lessonVersion,
    )!.frozen;
    const definition = frozen.definitions.find(
      (d) => formalInteractionSceneId(d.id) === input.binding.sceneId,
    )!;
    let result: number | string | null = null;
    let predictionMatched: boolean | null = null;
    if (definition.kind === 'parameter' && input.values.kind === 'parameter') {
      const { a, x, prediction } = input.values;
      const steps = (a - definition.min) / definition.step;
      if (a < definition.min || a > definition.max || Math.abs(steps - Math.round(steps)) > 1e-7)
        throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_parameter' });
      if (input.operation === 'submit') {
        // 本版本要求先给预测就必须给，否则「独立预测」会退化成可选装饰。
        if (definition.predictionRequired && prediction === null) {
          throw new StudyError(
            'INVALID_ARGUMENT',
            { reason: 'prediction_required' },
            '本版本要求先填写本人预测，再提交互动。',
          );
        }
        const actual = parameterResult(definition.formula, {
          a,
          x,
          intercept: definition.intercept,
        });
        result = actual;
        predictionMatched = predictionMatches(prediction, actual);
      }
    } else if (definition.kind === 'concept_relation' && input.values.kind === 'concept_relation') {
      const edgeId = input.values.edgeId;
      const edge = definition.edges.find((e) => e.id === edgeId);
      if (
        !edge ||
        !definition.nodes.some(
          (n) => input.values.kind === 'concept_relation' && n.id === input.values.to,
        )
      )
        throw new StudyError('INVALID_ARGUMENT');
      if (input.operation === 'submit')
        result = edge.to === input.values.to ? '关系核验一致' : '关系核验不一致，请对照来源重试';
    } else if (definition.kind === 'ordering' && input.values.kind === 'ordering') {
      const itemIds = definition.items.map((item) => item.id);
      const matched = orderingMatches(input.values.order, definition.correctOrder, itemIds);
      if (matched === null)
        throw new StudyError('INVALID_ARGUMENT', { reason: 'formal_interaction_order_invalid' });
      if (input.operation === 'submit')
        result = matched ? '排序核验一致' : '排序核验不一致，请对照来源重试';
    } else throw new StudyError('INVALID_ARGUMENT', { reason: 'interaction_type_mismatch' });
    const payload = formalInteractionRecordSchema.parse({
      version: 1,
      uid: session.learnerUid,
      recordScope: 'formal',
      actorType: 'human_learner',
      binding: state.binding,
      values: input.values,
      result,
      predictionMatched,
      mode: input.operation,
      nonce: input.nonce,
    });
    const sessionId = formalInteractionObservationSessionId(
      session.projectId,
      session.learnerUid,
      state.binding,
    );
    const records = session.store.runtime.listRecords(session.projectId, sessionId);
    const previous = records.find(
      (r) => formalInteractionRecordSchema.parse(r.payload).nonce === input.nonce,
    );
    if (previous) {
      // 去重比较要先把旧记录补成当前形状，否则「旧记录缺新字段」会被误判成换了内容。
      if (hash(formalInteractionRecordSchema.parse(previous.payload)) !== hash(payload))
        throw new StudyError('VERSION_CONFLICT', { reason: 'interaction_nonce_reused' });
      return { ...state, deduplicated: true };
    }
    const now = new Date().toISOString();
    if (!session.store.runtime.getSession(session.projectId, sessionId))
      session.store.runtime.createSession(session.projectId, {
        id: sessionId,
        kind: 'formalInteractionObservation',
        learnerKey: session.learnerUid,
        stageId: input.binding.stageId,
        runtimeDslVersion: RUNTIME_DSL_VERSION,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    session.store.runtime.appendRecord(
      session.projectId,
      {
        id: `formal-observation-${hash(payload)}`,
        sessionId,
        sceneId: input.binding.sceneId,
        createdAt: now,
        payload,
      },
      { expectedLastSeq: records.length ? records.length - 1 : null },
    );
    return loadFormalInteraction(session, input.binding.stageId, input.binding.sceneId);
  });
};
