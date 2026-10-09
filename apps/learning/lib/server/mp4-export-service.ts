import { createHash } from 'node:crypto';
import {
  StudyError,
  newId,
  mp4StartSchema,
  mp4ActionSchema,
  mp4TaskSchema,
  lessonExportResultSchema,
  type Mp4TaskDto,
  type PlanSceneDto,
} from '@sew/study-contracts';
import {
  applyMp4JobEvent,
  buildMp4RenderPlan,
  createMp4RenderJob,
  classroomDocumentDigest,
  mp4BlockingRuntimes,
  type Mp4RuntimeDeclaration,
  type Mp4JobEvent,
  type Mp4FailureClass,
} from '@sew/study-domain';
import { assertScope, type Session } from './service';
import { sanitizePublicValue } from './http';
import { loadRenderableFormalDocument } from './classroom-service';
import { readFormalLessonImages } from './formal-lesson-assets';
import { publishLessonExport, lessonExportFileName, readLessonExport } from './lesson-export-files';
import {
  inspectMp4Runtime,
  renderMp4,
  Mp4RenderError,
  type Mp4RuntimeInspection,
  type Mp4PublicDocument,
  type Mp4BoundedAsset,
} from './mp4-renderer';

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const globalState = globalThis as typeof globalThis & {
  __sewMp4Jobs?: Map<string, { controller: AbortController; promise?: Promise<void> }>;
};
const active = (globalState.__sewMp4Jobs ??= new Map());
const key = (projectId: string, jobId: string) => `${projectId}:${jobId}`;
const leaseKey = (jobId: string) => `mp4-export:${jobId}`;
type ExecutionLease = ReturnType<Session['store']['executions']['claim']>;
const scopeCurrent = (session: Session) => {
  if (
    assertScope({ projectId: session.projectId, generation: session.generation }).store !==
    session.store
  )
    throw new StudyError('PROJECT_GENERATION_STALE');
};
function source(session: Session, lessonId: string, version: number) {
  scopeCurrent(session);
  const ready = session.store.assertLessonClassroomReady(lessonId, session.projectId);
  if (ready.lesson.version !== version) throw new StudyError('VERSION_CONFLICT');
  const document = loadRenderableFormalDocument(session, lessonId);
  if (!document) throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED');
  const publicDocument = document.document as Mp4PublicDocument;
  const scenePlan = session.store.getScenePlan(session.projectId, lessonId, version);
  const bindings = session.store.listClassroomSceneSources(session.projectId, document.stageId);
  const scenes: PlanSceneDto[] =
    scenePlan?.scenes ??
    publicDocument.scenes.map((scene) => ({
      sceneId: scene.id,
      kind: scene.type as PlanSceneDto['kind'],
      title: scene.title,
      statementId: null,
      questionId: bindings.get(scene.id)?.questionId ?? null,
      knowledgeIds: bindings.get(scene.id)?.knowledgeIds ?? [],
      elements: [],
      note: '',
    }));
  if (
    scenes.length !== publicDocument.scenes.length ||
    scenes.some((scene, index) => scene.sceneId !== publicDocument.scenes[index]?.id)
  )
    throw new StudyError('VERSION_CONFLICT', { reason: 'mp4_scene_order_changed' });
  return { ready, document, publicDocument, scenePlan, scenes };
}
function assertSource(session: Session, task: Mp4TaskDto) {
  const frozen = source(session, task.plan.identity.lessonId, task.plan.identity.lessonVersion);
  if (
    frozen.ready.lesson.bundleDigest !== task.bundleDigest ||
    frozen.document.stageId !== task.stageId ||
    frozen.document.digest !== task.plan.identity.documentDigest ||
    classroomDocumentDigest(frozen.document.document) !==
      task.plan.identity.exportedDocumentDigest ||
    (frozen.scenePlan?.digest ?? null) !== task.plan.identity.planDigest
  )
    throw new StudyError('VERSION_CONFLICT', { reason: 'mp4_frozen_source_changed' });
  return frozen;
}
function declarations(
  inspection: Mp4RuntimeInspection,
  previous?: Mp4TaskDto,
): Mp4RuntimeDeclaration[] {
  return inspection.runtimes.map((fact) => {
    const kind = fact.kind === 'ffprobe' ? ('media-decoder' as const) : fact.kind;
    const old = previous?.plan.runtimes.find((runtime) => runtime.reference === fact.kind);
    const expectedDigest = old ? old.expectedDigest : fact.sha256;
    const mismatch = fact.available && expectedDigest !== null && fact.sha256 !== expectedDigest;
    return {
      kind,
      reference: fact.kind,
      required: true,
      minVersion: null,
      expectedDigest,
      actualVersion: fact.version,
      actualDigest: fact.sha256,
      status: mismatch ? 'mismatched' : fact.available ? 'available' : 'missing',
      note: mismatch ? '运行时摘要与任务冻结声明不同，请重新创建任务。' : fact.reason,
    };
  });
}
function advance(
  session: Session,
  task: Mp4TaskDto,
  event: Mp4JobEvent,
  payload: Parameters<typeof applyMp4JobEvent>[2],
  segment?: { index: number; bytes: Uint8Array },
) {
  scopeCurrent(session);
  return session.store.mp4.update(
    mp4TaskSchema.parse({
      ...task,
      revision: task.revision + 1,
      job: applyMp4JobEvent(task.job, event, payload, task.plan),
    }),
    task.revision,
    segment,
  );
}
export function readMp4Tasks(session: Session): Mp4TaskDto[] {
  scopeCurrent(session);
  return session.store.transaction(() =>
    session.store.mp4.list(session.projectId).map((task) => {
      if (
        ['queued', 'preparing', 'capturing', 'encoding'].includes(task.job.state) &&
        !session.store.executions.held(session.projectId, leaseKey(task.job.jobId))
      )
        return advance(session, task, 'fail', {
          at: now(),
          failure: {
            class: 'result-unknown',
            message: '上次执行已中断；复验检查点后须明确继续，不会自动重跑。',
            occurredAt: now(),
            segmentIndex: task.job.nextSegmentIndex,
          },
        });
      return task;
    }),
  );
}

type Execution = { inspect: typeof inspectMp4Runtime; render: typeof renderMp4 };
const runtime: Execution = { inspect: inspectMp4Runtime, render: renderMp4 };

async function execute(
  session: Session,
  initial: Mp4TaskDto,
  controller: AbortController,
  execution: Execution,
  initialLease: ExecutionLease,
) {
  let task = initial;
  let lease = initialLease;
  const commit = (
    event: Mp4JobEvent,
    payload: Parameters<typeof applyMp4JobEvent>[2],
    segment?: { index: number; bytes: Uint8Array },
  ) =>
    session.store.executions.withLease(lease, () =>
      advance(session, task, event, payload, segment),
    );
  const identity = key(task.projectId, task.job.jobId);
  const heartbeat = setInterval(() => {
    try {
      scopeCurrent(session);
      lease = session.store.executions.renew(lease, Date.now(), 120_000);
    } catch {
      controller.abort('执行租约失效');
      clearInterval(heartbeat);
    }
  }, 10_000);
  const guard = setInterval(() => {
    try {
      session.store.executions.assert(lease);
      assertSource(session, task);
    } catch {
      controller.abort('冻结课程或项目已变化');
    }
  }, 150);
  try {
    task = commit('begin-preparation', { at: now() });
    const facts = await execution.inspect({ signal: controller.signal });
    scopeCurrent(session);
    task = session.store.mp4.get(session.projectId, task.job.jobId)!;
    if (controller.signal.aborted || task.job.state === 'cancelled') return;
    const frozen = assertSource(session, task);
    const actual = declarations(facts, task);
    const gaps = mp4BlockingRuntimes(actual);
    if (gaps.length) {
      task = commit('resources-unavailable', { at: now(), blockingRuntimes: gaps });
      return;
    }
    task = commit('resources-verified', { at: now(), runtimes: actual });
    const assets = new Map<string, Mp4BoundedAsset>();
    for (const ref of readFormalLessonImages(
      session,
      task.stageId,
      frozen.document.document,
      task.plan.identity.lessonId,
      task.bundleDigest,
    )) {
      const asset = session.store.getClassroomAsset(session.projectId, ref.assetId)!;
      assets.set(ref.symbolicRef, {
        bytes: asset.bytes,
        mediaType: asset.mediaType,
        sha256: asset.sha256,
      });
    }
    const segments = session.store.mp4.segments(task);
    const output = await execution.render(task.plan, frozen.publicDocument, assets, {
      signal: controller.signal,
      resumeSegments: segments,
      onStage(stage) {
        assertSource(session, task);
        controller.signal.throwIfAborted();
        if (stage === 'capturing') task = commit('begin-capture', { at: now() });
        else {
          task = commit('capture-completed', { at: now() });
          task = commit('begin-encoding', { at: now() });
        }
      },
      onSegment(index, bytes) {
        assertSource(session, task);
        controller.signal.throwIfAborted();
        task = commit(
          'segment-captured',
          {
            at: now(),
            segmentIndex: index,
            artifact: { byteLength: bytes.length, sha256: sha256(bytes) },
          },
          { index, bytes },
        );
      },
    });
    scopeCurrent(session);
    const latest = session.store.mp4.get(session.projectId, task.job.jobId)!;
    if (latest.job.state === 'cancelled') return;
    controller.signal.throwIfAborted();
    assertSource(session, task);
    if (
      !output.playable ||
      !output.evidence.fullDecodeVerified ||
      !output.evidence.ffprobeVerified ||
      output.byteLength !== output.bytes.length ||
      output.sha256 !== sha256(output.bytes) ||
      mp4BlockingRuntimes(declarations(output.runtimes, task)).length > 0
    )
      throw new StudyError('INTERNAL', { reason: 'mp4_output_unverified' });
    const fileName = lessonExportFileName(
      task.plan.identity.lessonId,
      task.plan.identity.lessonVersion,
      'mp4',
    );
    const result = lessonExportResultSchema.parse({
      projectId: task.projectId,
      lessonId: task.plan.identity.lessonId,
      lessonVersion: task.plan.identity.lessonVersion,
      format: 'mp4',
      destination: `exports/${fileName}`,
      fileName,
      byteLength: output.bytes.length,
      sha256: output.sha256,
      manifest: {
        containerVersion: 1,
        format: 'mp4',
        createdAt: now(),
        projectId: task.projectId,
        lessonId: task.plan.identity.lessonId,
        lessonVersion: task.plan.identity.lessonVersion,
        title: task.plan.identity.title,
        stageId: task.stageId,
        dslVersion: task.dslVersion,
        documentDigest: task.plan.identity.documentDigest,
        exportedDocumentDigest: task.plan.identity.exportedDocumentDigest,
        bundleDigest: task.bundleDigest,
        planDigest: task.plan.identity.planDigest,
        sceneCount: task.plan.segments.length,
        entries: [{ path: fileName, byteLength: output.bytes.length, sha256: output.sha256 }],
        resources: [
          {
            kind: 'other',
            reference: 'linear-silent-projection',
            status: 'missing',
            note: '当前导出为冻结幻灯片与测验题面的静音线性视频，不包含互动操作、答题提交或授课音轨。',
          },
        ],
      },
      unresolvedAssets: [],
      message: 'MP4 已完成真实编码与全量解码验证；这是静音线性公开投影。',
    });
    task = session.store.executions.withLease(lease, () =>
      session.store.mp4.update(
        mp4TaskSchema.parse({
          ...task,
          revision: task.revision + 1,
          prepared: { result, evidence: output.evidence },
        }),
        task.revision,
      ),
    );
    const completed = mp4TaskSchema.parse({
      ...task,
      revision: task.revision + 1,
      job: applyMp4JobEvent(
        task.job,
        'encoding-completed',
        {
          at: now(),
          output: {
            fileName,
            byteLength: output.bytes.length,
            sha256: output.sha256,
            playable: true,
          },
        },
        task.plan,
      ),
      result,
    });
    session.store.executions.withLease(lease, () => {
      assertSource(session, task);
      controller.signal.throwIfAborted();
      publishLessonExport(session.displayPath, fileName, output.bytes);
      session.store.mp4.update(completed, task.revision);
    });
  } catch (error) {
    try {
      scopeCurrent(session);
      session.store.executions.assert(lease);
      const latest = session.store.mp4.get(session.projectId, task.job.jobId);
      if (!latest || ['succeeded', 'cancelled', 'failed', 'blocked'].includes(latest.job.state))
        return;
      const failure: Mp4FailureClass = controller.signal.aborted
        ? 'plan-drift'
        : error instanceof Mp4RenderError
          ? error.code === 'timeout'
            ? 'timeout'
            : error.code === 'runtime-missing'
              ? 'runtime-missing'
              : error.code === 'encode-failed'
                ? 'encoder-crashed'
                : error.code === 'output-invalid'
                  ? 'artifact-digest-mismatch'
                  : 'browser-crash'
          : error instanceof StudyError && !latest.prepared
            ? 'plan-drift'
            : 'result-unknown';
      session.store.executions.withLease(lease, () =>
        advance(session, latest, 'fail', {
          at: now(),
          failure: {
            class: failure,
            occurredAt: now(),
            segmentIndex: latest.job.nextSegmentIndex,
            message:
              error instanceof Mp4RenderError
                ? String(sanitizePublicValue(error.message)).slice(0, 1000)
                : '执行已停止，请检查冻结课程、运行时和资源后明确处理。',
          },
        }),
      );
    } catch {
      /* Closed projects retain the durable unfinished receipt for explicit recovery. */
    }
  } finally {
    clearInterval(guard);
    clearInterval(heartbeat);
    try {
      scopeCurrent(session);
      session.store.executions.release(lease);
    } catch {
      /* A closed project or replacement executor owns recovery. */
    }
    if (active.get(identity)?.controller === controller) active.delete(identity);
  }
}
function launch(session: Session, task: Mp4TaskDto, execution: Execution) {
  const controller = new AbortController();
  const lease = session.store.executions.claim({
    projectId: session.projectId,
    key: leaseKey(task.job.jobId),
    ownerId: newId('mp4_executor'),
    now: Date.now(),
    ttlMs: 120_000,
  });
  const entry = { controller, promise: undefined as Promise<void> | undefined };
  active.set(key(task.projectId, task.job.jobId), entry);
  entry.promise = execute(session, task, controller, execution, lease);
}
export async function startMp4Task(
  session: Session,
  input: unknown,
  execution: Execution = runtime,
): Promise<Mp4TaskDto> {
  const command = mp4StartSchema.parse(input);
  assertScope(command.scope);
  scopeCurrent(session);
  const intent = sha256(
    JSON.stringify({
      projectId: session.projectId,
      lessonId: command.lessonId,
      version: command.version,
    }),
  );
  const existing = session.store.mp4.byRequest(session.projectId, command.requestId, intent);
  if (existing) return readMp4Tasks(session).find((task) => task.job.jobId === existing.job.jobId)!;
  readMp4Tasks(session);
  const frozen = source(session, command.lessonId, command.version);
  const facts = await execution.inspect();
  scopeCurrent(session);
  const current = source(session, command.lessonId, command.version);
  const raced = session.store.mp4.byRequest(session.projectId, command.requestId, intent);
  if (raced) return raced;
  if (current.document.digest !== frozen.document.digest) throw new StudyError('VERSION_CONFLICT');
  const plan = buildMp4RenderPlan({
    identity: {
      projectId: session.projectId,
      lessonId: command.lessonId,
      lessonVersion: command.version,
      bundleId: frozen.ready.lesson.bundleId,
      title: frozen.ready.lesson.title,
      planDigest: frozen.scenePlan?.digest ?? null,
      documentDigest: frozen.document.digest,
      exportedDocumentDigest: classroomDocumentDigest(frozen.document.document),
    },
    scenes: frozen.scenes,
    encoding: {
      container: 'mp4',
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      width: 1280,
      height: 720,
      fps: 10,
      constantRateFactor: 23,
      fastStart: true,
      audio: null,
    },
    canvas: { viewportSize: 1000, viewportRatio: 9 / 16 },
    runtimes: declarations(facts),
    generatedAt: now(),
  });
  const task = session.store.mp4.start(
    mp4TaskSchema.parse({
      schemaVersion: 1,
      projectId: session.projectId,
      intent,
      revision: 0,
      bundleDigest: frozen.ready.lesson.bundleDigest,
      stageId: frozen.document.stageId,
      dslVersion: frozen.document.dslVersion,
      plan,
      job: createMp4RenderJob({
        jobId: `mp4_${sha256(`${session.projectId}:${command.requestId}`).slice(0, 32)}`,
        requestId: command.requestId,
        plan,
        at: now(),
      }),
      result: null,
    }),
  );
  launch(session, task, execution);
  return session.store.mp4.get(session.projectId, task.job.jobId)!;
}
export async function actionMp4Task(
  session: Session,
  input: unknown,
  execution: Execution = runtime,
): Promise<Mp4TaskDto> {
  const command = mp4ActionSchema.parse(input);
  assertScope(command.scope);
  scopeCurrent(session);
  let task = session.store.mp4.get(session.projectId, command.jobId);
  if (!task) throw new StudyError('NOT_FOUND');
  if (task.revision !== command.expectedRevision) throw new StudyError('VERSION_CONFLICT');
  const identity = key(session.projectId, command.jobId);
  if (command.action === 'cancel') {
    if (task.job.state === 'cancelled') return task;
    active.get(identity)?.controller.abort('用户取消');
    return session.store.transaction(() => {
      const lease = session.store.executions.held(session.projectId, leaseKey(task!.job.jobId));
      if (lease) session.store.executions.release(lease);
      return advance(session, task!, 'cancel', { at: now() });
    });
  }
  if (
    active.has(identity) ||
    session.store.executions.held(session.projectId, leaseKey(task.job.jobId))
  )
    throw new StudyError('VERSION_CONFLICT', { reason: 'mp4_still_running' });
  assertSource(session, task);
  if (
    task.job.state === 'failed' &&
    task.job.failure?.class === 'result-unknown' &&
    task.prepared
  ) {
    const result = task.prepared.result;
    try {
      // The durable pre-publication receipt binds the bytes already fully decoded before the crash.
      // A complete SHA-256 match reuses that decode proof even if runtime installation has since changed.
      const artifact = readLessonExport(
        session,
        result.lessonId,
        result.lessonVersion,
        'mp4',
        result.sha256,
      );
      if (artifact.bytes.length !== result.byteLength) throw new StudyError('VERSION_CONFLICT');
      return session.store.mp4.update(
        mp4TaskSchema.parse({
          ...task,
          revision: task.revision + 1,
          result,
          job: applyMp4JobEvent(
            task.job,
            'output-reconciled',
            {
              at: now(),
              output: {
                fileName: result.fileName,
                sha256: result.sha256,
                byteLength: result.byteLength,
                playable: true,
              },
            },
            task.plan,
          ),
        }),
        task.revision,
      );
    } catch (error) {
      if (!(error instanceof StudyError) || !['NOT_FOUND', 'VERSION_CONFLICT'].includes(error.code))
        throw error;
      // A missing/changed file cannot borrow the saved decode proof; explicitly continue from captures.
    }
  }
  session.store.mp4.segments(task);
  const facts = await execution.inspect();
  scopeCurrent(session);
  assertSource(session, task);
  task = advance(session, task, 'requeue', { at: now(), runtimes: declarations(facts, task) });
  launch(session, task, execution);
  return session.store.mp4.get(session.projectId, task.job.jobId)!;
}
/** Test/operator drain; no polling action creates a new execution. */
export async function waitForMp4Task(projectId: string, jobId: string) {
  await active.get(key(projectId, jobId))?.promise;
}
