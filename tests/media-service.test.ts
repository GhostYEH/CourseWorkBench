import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StudyError,
  zeroMediaUsage,
  type MediaGenerationCommandDto,
  type PlanPayloadDto,
} from '@sew/study-contracts';
import {
  openProjectFromDisk,
  closeProject,
  type Session,
} from '../apps/learning/lib/server/service';
import {
  generateMediaTask,
  readMediaTasks,
  reviewMediaTask,
  cancelMediaTask,
  readMediaProduct,
} from '../apps/learning/lib/server/media-service';
import type { MediaProviderConnection } from '../apps/learning/lib/server/model-connection';
import type { MediaProviderOutcome } from '../apps/learning/lib/server/media-provider-runtime';
import { POST as lessonsPost } from '../apps/learning/app/api/study/lessons/route';
import { GET as lessonAssets } from '../apps/learning/app/api/maic/lesson-assets/[stageId]/route';
import { exportPptxLesson } from '../apps/learning/lib/server/pptx-export-service';
import { loadRenderableFormalDocument } from '../apps/learning/lib/server/classroom-service';
import { readZip } from '@sew/study-storage';
import { encodeRecordingWav } from '../apps/learning/lib/recording-wav';

describe('persistent guarded media generation', () => {
  let root: string;
  let session: Session;
  let lessonId: string;
  let statementId: string;
  let knowledgeId: string;
  let runId: string;
  let connection: MediaProviderConnection;
  let epoch: number;
  const roots: string[] = [];
  const text = '同一区间内任取 x1 小于 x2 时，增函数满足 f(x1) 小于 f(x2)。';
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const outcome = (over: Partial<MediaProviderOutcome> = {}): MediaProviderOutcome => ({
    dispatched: true,
    ok: true,
    failureKind: null,
    products: [{ bytes, mime: 'image/png', durationSeconds: null }],
    usage: {
      ...zeroMediaUsage(),
      images: 1,
      tokens: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    },
    usageMeasurement: 'actual',
    elapsedMs: 1,
    message: 'fixture',
    ...over,
  });
  const command = (over: Record<string, unknown> = {}): MediaGenerationCommandDto =>
    ({
      scope: { projectId: session.projectId, generation: session.generation, runId },
      requestId: 'media-request-1',
      lessonId,
      provider: 'openai-compatible',
      kind: 'image',
      prompt: '绘制函数示意图',
      workflowId: 'default',
      workflowLocation: 'remote',
      width: 1024,
      height: 1024,
      steps: 20,
      guidance: 7,
      count: 1,
      ...over,
    }) as MediaGenerationCommandDto;
  const review = (
    task: Awaited<ReturnType<typeof generateMediaTask>>,
    over: Record<string, unknown> = {},
  ) =>
    reviewMediaTask(session, {
      scope: { projectId: session.projectId, generation: session.generation },
      taskId: task.taskId,
      intent: task.intent,
      decision: 'approved',
      semanticReviewed: true,
      note: '核对原文',
      ...over,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-media-service-'));
    roots.push(root);
    session = openProjectFromDisk(root);
    const { store, projectId } = session;
    const material = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: text,
    });
    const proposal = store.createProposal({
      projectId,
      name: '增函数',
      concept: text,
      conditions: '同一区间',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [
        {
          materialId: material.material.materialId,
          revision: 1,
          segmentId: material.segments[0]!.segmentId,
          use: 'concept_basis',
        },
      ],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    const plan: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握增函数',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数',
          minutes: 30,
          acceptance: '',
          evidence: [
            {
              materialId: material.material.materialId,
              segmentId: material.segments[0]!.segmentId,
            },
          ],
        },
      ],
      gaps: [],
      basis: '冻结来源',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    store.savePlanVersion(projectId, 1, 'confirmed', plan);
    runId = store.startPlanRun(projectId).run.runId;
    const bundle = store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text, conditions: '同一区间' }],
      [],
    );
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '增函数',
      bundleId: bundle.bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    store.reviewLesson({ projectId, lessonId, version: 1, decision: 'approved', note: '核对原文' });
    store.publishLesson({ projectId, lessonId, version: 1 });
    epoch = 0;
    connection = {
      status: () => ({
        configured: true,
        persisted: false,
        provider: 'openai-compatible',
        model: 'fixture',
        baseUrl: 'https://fixture.test/v1',
        lastTest: null,
      }),
      revision: () => epoch,
      generateMedia: vi.fn(async () => outcome()),
    };
  });
  afterEach(() => {
    closeProject();
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('uses approved images in a new reviewed lesson, actual classroom asset manifest and editable PPTX', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
      'base64',
    );
    vi.mocked(connection.generateMedia).mockResolvedValue(
      outcome({ products: [{ bytes: png, mime: 'image/png', durationSeconds: null }] }),
    );
    const task = await generateMediaTask(session, command(), { connection });
    const assetId = task.products[0]!.assetId;
    const published = session.store.getLessonVersion(lessonId, 1, session.projectId)!;
    const draft = session.store.createLessonDraft({
      projectId: session.projectId,
      lessonId,
      title: '含审核图片',
      bundleId: published.bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    const post = (body: Record<string, unknown>) =>
      lessonsPost(
        new Request('http://localhost/api/study/lessons', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: { projectId: session.projectId, generation: session.generation },
            ...body,
          }),
        }),
      );
    const scene = {
      sceneId: 'scene_image',
      kind: 'slide',
      title: '增函数',
      statementId,
      questionId: null,
      knowledgeIds: [knowledgeId],
      note: '',
      elements: [
        {
          elementId: 'el_body',
          kind: 'text',
          text,
          assetRef: null,
          left: 60,
          top: 130,
          width: 500,
          height: 250,
          style: { fontSize: 24, color: '#232323', bold: true, italic: false, align: 'left' },
        },
        {
          elementId: 'el_picture',
          kind: 'image',
          text: '',
          assetRef: assetId,
          left: 620,
          top: 140,
          width: 280,
          height: 230,
          style: { fontSize: 24, color: '#232323', bold: false, italic: false, align: 'left' },
        },
      ],
    };
    expect(
      (
        await post({
          action: 'save-scene-plan',
          requestId: 'image-plan-unreviewed',
          lessonId,
          version: draft.version,
          baseRevision: 0,
          scenes: [scene],
        })
      ).status,
    ).toBe(403);
    review(task);
    const saved = await post({
      action: 'save-scene-plan',
      requestId: 'image-plan-approved',
      lessonId,
      version: draft.version,
      baseRevision: 0,
      scenes: [scene],
    });
    expect(saved.status, JSON.stringify(await saved.json())).toBe(200);
    expect(
      (
        await post({
          action: 'review',
          lessonId,
          version: draft.version,
          decision: 'approved',
          note: '核对正文与图片',
        })
      ).status,
    ).toBe(200);
    expect((await post({ action: 'publish', lessonId, version: draft.version })).status).toBe(200);
    const attached = await post({ action: 'attach-document', lessonId, version: draft.version });
    expect(attached.status, JSON.stringify(await attached.json())).toBe(200);
    const document = loadRenderableFormalDocument(session, lessonId)!;
    const response = await lessonAssets(
      new Request('http://localhost/api/maic/lesson-assets/unused', {
        headers: {
          'x-sew-project-id': session.projectId,
          'x-sew-generation': String(session.generation),
        },
      }),
      { params: Promise.resolve({ stageId: document.stageId }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.assets).toEqual([
      { assetId, symbolicRef: assetId, mediaType: 'image/png', sha256: task.products[0]!.sha256 },
    ]);
    const pptx = await exportPptxLesson(session, lessonId, draft.version);
    const file = (await import('node:fs')).readFileSync(join(root, 'exports', pptx.fileName));
    const parts = readZip(file, { allowEmptyDirectories: true });
    expect(
      parts.some(
        (part) => part.path.startsWith('ppt/media/') && Buffer.from(part.bytes).equals(png),
      ),
    ).toBe(true);
    const xml = parts
      .filter((part) => /^ppt\/slides\/slide\d+\.xml$/.test(part.path))
      .map((part) => Buffer.from(part.bytes).toString())
      .join('');
    expect(xml).toContain('<p:pic>');
    expect(xml).toContain('b="1"');
    writeFileSync(join(root, '.study', 'assets', assetId), 'corrupt');
    expect(() => loadRenderableFormalDocument(session, lessonId)).toThrow();
  });

  it('grounds prompts, stores candidate bytes and settles both ledgers once', async () => {
    const task = await generateMediaTask(session, command(), { connection });
    expect(task.observation).toMatchObject({ state: 'completed', usageMeasurement: 'actual' });
    expect(task.review.status).toBe('pending_review');
    expect(task.products[0]).toMatchObject({
      authority: false,
      reviewStatus: 'pending_review',
      byteLength: 4,
    });
    expect(vi.mocked(connection.generateMedia).mock.calls[0]![0]).toMatchObject({
      prompt: expect.stringContaining(text),
    });
    expect(Array.from(readMediaProduct(session, task.products[0]!.assetId).bytes)).toEqual(
      Array.from(bytes),
    );
    expect(session.store.modelCallUsage(runId)).toMatchObject({ calls: 1, tokens: 20 });
    expect(readMediaTasks(session).ledger?.total.actual).toMatchObject({ images: 1, tokens: 20 });
    expect(await generateMediaTask(session, command(), { connection })).toEqual(task);
    expect(connection.generateMedia).toHaveBeenCalledTimes(1);
    expect(review(task).review.status).toBe('approved');
  });

  it('binds request IDs to original intent and rejects changed prompt', async () => {
    await generateMediaTask(session, command(), { connection });
    await expect(
      generateMediaTask(session, command({ prompt: '另一图像' }), { connection }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(connection.generateMedia).toHaveBeenCalledTimes(1);
  });

  it('reads a settled receipt after project reopen without calling provider again', async () => {
    const original = command();
    const task = await generateMediaTask(session, original, { connection });
    closeProject();
    session = openProjectFromDisk(root);
    expect(
      await generateMediaTask(
        session,
        { ...original, scope: { ...original.scope, generation: session.generation } },
        { connection },
      ),
    ).toEqual(task);
    expect(connection.generateMedia).toHaveBeenCalledTimes(1);
  });

  it('retains a recovered started record and cancels it without automatic dispatch', async () => {
    const original = command();
    vi.mocked(connection.generateMedia).mockImplementation(async () => {
      closeProject();
      return outcome();
    });
    await expect(generateMediaTask(session, original, { connection })).rejects.toThrow(StudyError);
    session = openProjectFromDisk(root);
    const recovered = await generateMediaTask(
      session,
      { ...original, scope: { ...original.scope, generation: session.generation } },
      { connection },
    );
    expect(recovered.observation.state).toBe('started');
    expect(connection.generateMedia).toHaveBeenCalledTimes(1);
    const cancelled = cancelMediaTask(session, recovered.taskId);
    expect(cancelled.observation).toMatchObject({
      state: 'failed',
      failureKind: 'cancelled',
      usageMeasurement: 'unknown',
    });
    expect(session.store.modelCallUsage(runId).tokens).toBe(
      recovered.observation.reserved.tokens.totalTokens,
    );
  });

  it('returns an in-flight persistent task on retry, then only aborts this task on cancel', async () => {
    let dispatched!: () => void;
    const ready = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    vi.mocked(connection.generateMedia).mockImplementation(async (_command, options) => {
      dispatched();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return outcome({
        ok: false,
        failureKind: 'cancelled',
        products: [],
        usage: null,
        usageMeasurement: 'unknown',
      });
    });
    const pending = generateMediaTask(session, command(), { connection });
    await ready;
    const repeated = await generateMediaTask(session, command(), { connection });
    expect(repeated.observation.state).toBe('started');
    const cancelled = cancelMediaTask(session, repeated.taskId);
    expect(cancelled.observation).toMatchObject({
      state: 'failed',
      failureKind: 'cancelled',
      usageMeasurement: 'unknown',
    });
    expect(await pending).toEqual(cancelled);
    expect(session.store.modelCallUsage(runId).tokens).toBe(
      repeated.observation.reserved.tokens.totalTokens,
    );
    expect(connection.generateMedia).toHaveBeenCalledTimes(1);
  });

  it('does not persist products or zero unknown consumption when the provider throws', async () => {
    vi.mocked(connection.generateMedia).mockRejectedValue(new Error('private provider failure'));
    const task = await generateMediaTask(session, command(), { connection });
    expect(task.observation).toMatchObject({
      state: 'failed',
      failureKind: 'unknown_outcome',
      usageMeasurement: 'unknown',
      accounted: null,
    });
    expect(task.products).toEqual([]);
    expect(readMediaTasks(session).ledger?.total.unknown.images).toBe(1);
    expect(session.store.modelCallUsage(runId).tokens).toBe(
      task.observation.reserved.tokens.totalTokens,
    );
  });

  it('releases reservation only for a known refusal before dispatch', async () => {
    vi.mocked(connection.generateMedia).mockResolvedValue(
      outcome({
        dispatched: false,
        ok: false,
        failureKind: 'provider_not_configured',
        products: [],
        usage: null,
        usageMeasurement: 'unknown',
      }),
    );
    const task = await generateMediaTask(session, command(), { connection });
    expect(task.observation).toMatchObject({
      state: 'failed',
      usageMeasurement: 'actual',
      accounted: zeroMediaUsage(),
    });
    expect(session.store.modelCallUsage(runId)).toMatchObject({
      calls: 0,
      tokens: 0,
      activeElapsedMs: 0,
    });
  });

  it('keeps missing token evidence reserved even when image count is actually observed', async () => {
    vi.mocked(connection.generateMedia).mockResolvedValue(
      outcome({
        usage: {
          ...zeroMediaUsage(),
          tokens: { promptTokens: null, completionTokens: null, totalTokens: null },
          images: 1,
        },
      }),
    );
    const task = await generateMediaTask(session, command(), { connection });
    expect(task.observation.state).toBe('completed');
    expect(
      session.store.getModelUsageCall(session.projectId, task.command.requestId)?.tokenMeasurement,
    ).toBe('unknown');
    expect(session.store.modelCallUsage(runId).tokens).toBe(
      task.observation.reserved.tokens.totalTokens,
    );
  });

  it('rejects success with no usage evidence and ignores failure products', async () => {
    vi.mocked(connection.generateMedia).mockResolvedValue(
      outcome({ usage: null, usageMeasurement: 'unknown' }),
    );
    const task = await generateMediaTask(session, command(), { connection });
    expect(task.observation.state).toBe('failed');
    expect(task.products).toEqual([]);
    vi.mocked(connection.generateMedia).mockResolvedValue(
      outcome({ ok: false, failureKind: 'provider_error' }),
    );
    const failed = await generateMediaTask(session, command({ requestId: 'media-failure-2' }), {
      connection,
    });
    expect(failed.products).toEqual([]);
  });

  it('rejects unpublished lesson, wrong run and unauthenticated TTS before provider', async () => {
    await expect(
      generateMediaTask(session, command({ lessonId: null }), { connection }),
    ).rejects.toMatchObject({ code: 'CLASSROOM_LESSON_NOT_REVIEWED' });
    await expect(
      generateMediaTask(
        session,
        command({
          scope: {
            projectId: session.projectId,
            generation: session.generation,
            runId: 'wrong-run',
          },
        }),
        { connection },
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const tts: MediaGenerationCommandDto = {
      scope: command().scope,
      requestId: 'tts',
      lessonId,
      provider: 'openai-compatible',
      kind: 'tts',
      text: '未经来源核对的全新知识',
      voiceId: 'alloy',
      playbackRate: 1,
    };
    await expect(generateMediaTask(session, tts, { connection })).rejects.toMatchObject({
      code: 'CLASSROOM_SCENE_SOURCE_MISSING',
    });
    expect(connection.generateMedia).not.toHaveBeenCalled();
  });

  it('reserves enough TTS seconds for actual audio duration without rejecting a valid frozen text', async () => {
    vi.mocked(connection.generateMedia).mockResolvedValue(
      outcome({
        products: [{ bytes, mime: 'audio/mpeg', durationSeconds: 5 }],
        usage: { ...zeroMediaUsage(), characters: text.length, audioSeconds: 5 },
      }),
    );
    const task = await generateMediaTask(
      session,
      {
        scope: command().scope,
        requestId: 'tts',
        lessonId,
        provider: 'openai-compatible',
        kind: 'tts',
        text,
        voiceId: 'alloy',
        playbackRate: 1,
      },
      { connection },
    );
    expect(task.observation).toMatchObject({ state: 'completed', reserved: { audioSeconds: 600 } });
    expect(readMediaTasks(session).ledger?.total.actual.seconds).toBe(5);
  });

  it('requires recorded ASR duration to match actual WAV frames before reserving or dispatching', async () => {
    const audio = encodeRecordingWav([new Float32Array(16000 * 3)], 16000);
    session.store.putClassroomAsset(
      session.projectId,
      'recorded',
      'audio/wav',
      { origin: 'user_recorded', durationSeconds: 1 },
      audio,
    );
    const asr: MediaGenerationCommandDto = {
      scope: { projectId: session.projectId, generation: session.generation, runId },
      requestId: 'recorded-asr',
      lessonId,
      provider: 'openai-compatible',
      kind: 'asr',
      engine: 'remote',
      microphoneGranted: true,
      audioAssetId: 'recorded',
      audioSeconds: 1,
    };
    await expect(generateMediaTask(session, asr, { connection })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'media_recording_duration_mismatch' },
    });
    expect(session.store.media.list(session.projectId)).toHaveLength(0);
    expect(connection.generateMedia).not.toHaveBeenCalled();
    vi.mocked(connection.generateMedia).mockResolvedValue(
      outcome({
        products: [
          {
            bytes: new TextEncoder().encode('转写候选'),
            mime: 'text/plain',
            durationSeconds: null,
          },
        ],
        usage: { ...zeroMediaUsage(), asrSeconds: 3 },
        usageMeasurement: 'estimated',
      }),
    );
    const task = await generateMediaTask(session, { ...asr, audioSeconds: 3 }, { connection });
    expect(task.observation.state).toBe('completed');
    expect(connection.generateMedia).toHaveBeenCalledOnce();
    expect(() => session.store.deleteClassroomAsset(session.projectId, 'recorded')).toThrow();
    expect(() =>
      session.store.putClassroomAsset(
        session.projectId,
        'recorded',
        'audio/wav',
        {},
        encodeRecordingWav([new Float32Array(16000)], 16000),
      ),
    ).toThrow();
    expect(
      session.store
        .listReclaimableAssets(session.projectId, 'formal')
        .some((asset) => asset.assetId === 'recorded'),
    ).toBe(false);
  });

  it('ASR requires explicit permission, a local stored audio asset and a configured engine', async () => {
    const asr: MediaGenerationCommandDto = {
      scope: command().scope,
      requestId: 'asr',
      lessonId,
      provider: 'openai-compatible',
      kind: 'asr',
      engine: 'remote',
      microphoneGranted: false,
      audioSeconds: 3,
    };
    await expect(generateMediaTask(session, asr, { connection })).rejects.toMatchObject({
      code: 'ROLE_PERMISSION_DENIED',
    });
    await expect(
      generateMediaTask(
        session,
        { ...asr, microphoneGranted: true, audioAssetId: 'external-url' },
        { connection },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      generateMediaTask(
        session,
        { ...asr, microphoneGranted: true, engine: 'local_whisper', audioAssetId: 'external-url' },
        { connection },
      ),
    ).rejects.toMatchObject({ details: { reason: 'media_asr_asset_invalid' } });
    expect(connection.generateMedia).not.toHaveBeenCalled();
  });

  it('passes the explicitly authorized stored WAV into a configured local ASR consumer', async () => {
    const audio = encodeRecordingWav([new Float32Array(16_000)], 16_000);
    session.store.putClassroomAsset(
      session.projectId,
      'local-recording',
      'audio/wav',
      { origin: 'user_recorded', durationSeconds: 1 },
      audio,
    );
    vi.mocked(connection.generateMedia).mockResolvedValue(
      outcome({
        products: [
          {
            bytes: new TextEncoder().encode('本地转写候选'),
            mime: 'text/plain',
            durationSeconds: 1,
          },
        ],
        usage: { ...zeroMediaUsage(), asrSeconds: 1 },
      }),
    );
    const localConnection: MediaProviderConnection = { ...connection, mediaConfigured: () => true };
    const task = await generateMediaTask(
      session,
      {
        scope: command().scope,
        requestId: 'local-asr-dispatch',
        lessonId,
        provider: 'funasr',
        kind: 'asr',
        engine: 'local_funasr',
        microphoneGranted: true,
        audioAssetId: 'local-recording',
        audioSeconds: 1,
      },
      { connection: localConnection },
    );
    expect(task.observation.state).toBe('completed');
    expect(vi.mocked(connection.generateMedia)).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'local_funasr', microphoneGranted: true }),
      expect.objectContaining({ audio: { bytes: audio, mime: 'audio/wav' } }),
    );
  });

  it('passes only verified stored audio bytes to remote ASR and saves a candidate transcript', async () => {
    session.store.putClassroomAsset(session.projectId, 'local_audio', 'audio/wav', {}, bytes);
    vi.mocked(connection.generateMedia).mockResolvedValue(
      outcome({
        products: [
          { bytes: new TextEncoder().encode('增函数'), mime: 'text/plain', durationSeconds: null },
        ],
        usage: { ...zeroMediaUsage(), asrSeconds: 3 },
      }),
    );
    const task = await generateMediaTask(
      session,
      {
        scope: command().scope,
        requestId: 'asr',
        lessonId,
        provider: 'openai-compatible',
        kind: 'asr',
        engine: 'remote',
        microphoneGranted: true,
        audioAssetId: 'local_audio',
        audioSeconds: 3,
      },
      { connection },
    );
    expect(task.observation.state).toBe('completed');
    expect(vi.mocked(connection.generateMedia).mock.calls[0]![1]?.audio?.mime).toBe('audio/wav');
    expect(
      Array.from(vi.mocked(connection.generateMedia).mock.calls[0]![1]?.audio?.bytes ?? []),
    ).toEqual(Array.from(bytes));
    expect(task.products[0]?.authority).toBe(false);
  });

  it('rejects stale lesson review after a new version is published and requires semantic confirmation', async () => {
    const task = await generateMediaTask(session, command(), { connection });
    expect(() => review(task, { semanticReviewed: false })).toThrow(StudyError);
    const old = session.store.getLessonVersion(lessonId, 1, session.projectId)!;
    const draft = session.store.createLessonDraft({
      projectId: session.projectId,
      lessonId,
      title: '新版本',
      bundleId: old.bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    session.store.reviewLesson({
      projectId: session.projectId,
      lessonId,
      version: draft.version,
      decision: 'approved',
      note: '',
    });
    session.store.publishLesson({ projectId: session.projectId, lessonId, version: draft.version });
    expect(() => review(task)).toThrow(StudyError);
    expect(session.store.media.byId(session.projectId, task.taskId)?.review.status).toBe(
      'pending_review',
    );
  });

  it('aborts changed connection during flight and discards a late success', async () => {
    vi.mocked(connection.generateMedia).mockImplementation(async (_input, options) => {
      epoch += 1;
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return outcome();
    });
    const task = await generateMediaTask(session, command(), { connection });
    expect(task.observation).toMatchObject({ state: 'failed', failureKind: 'cancelled' });
    expect(task.products).toEqual([]);
  });

  it('checks project scope before touching a closed DB after await', async () => {
    const oldStore = session.store;
    vi.mocked(connection.generateMedia).mockImplementation(async () => {
      const other = mkdtempSync(join(tmpdir(), 'sew-media-other-'));
      roots.push(other);
      session = openProjectFromDisk(other);
      return outcome();
    });
    const byId = vi.spyOn(oldStore.media, 'byId');
    await expect(generateMediaTask(session, command(), { connection })).rejects.toMatchObject({
      code: 'PROJECT_GENERATION_STALE',
    });
    expect(byId).not.toHaveBeenCalled();
  });

  it('applies the shared model call budget to media before dispatch', async () => {
    for (let index = 0; index < 8; index += 1)
      await generateMediaTask(session, command({ requestId: `media-budget-${index}` }), {
        connection,
      });
    await expect(
      generateMediaTask(session, command({ requestId: 'media-budget-extra' }), { connection }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(connection.generateMedia).toHaveBeenCalledTimes(8);
  });
});
