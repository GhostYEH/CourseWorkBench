import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  openProjectFromDisk,
  closeProject,
  type Session,
} from '../apps/learning/lib/server/service';
import { attachFormalLessonDocument } from '../apps/learning/lib/server/classroom-service';
import {
  startMp4Task,
  readMp4Tasks,
  waitForMp4Task,
  actionMp4Task,
} from '../apps/learning/lib/server/mp4-export-service';
import {
  type Mp4RuntimeInspection,
  type renderMp4,
  type inspectMp4Runtime,
} from '../apps/learning/lib/server/mp4-renderer';
import { readLessonExport } from '../apps/learning/lib/server/lesson-export-files';
import { createNodeSqliteDriver } from '@sew/study-storage';
import {
  inspectMp4Runtime as nativeInspectMp4Runtime,
  renderMp4 as nativeRenderMp4,
} from '../apps/learning/lib/server/mp4-renderer';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const facts: Mp4RuntimeInspection = {
  ready: true,
  gaps: [],
  runtimes: ['chromium', 'ffmpeg', 'ffprobe'].map((kind) => ({
    kind: kind as 'chromium' | 'ffmpeg' | 'ffprobe',
    path: null,
    version: 'fixture-v1',
    sha256: 'a'.repeat(64),
    available: true,
    reason: '',
  })),
};
describe('durable MP4 service using a controlled renderer fixture', () => {
  let directory: string;
  let session: Session;
  let lessonId: string;
  let execution: {
    inspect: ReturnType<typeof vi.fn<typeof inspectMp4Runtime>>;
    render: ReturnType<typeof vi.fn<typeof renderMp4>>;
  };
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const command = (requestId = 'mp4-request') => ({
    scope: scope(),
    requestId,
    lessonId,
    version: 1,
  });
  const bytes = Uint8Array.from([4, 3, 2, 1]);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sew-mp4-service-'));
    session = openProjectFromDisk(directory);
    const { store, projectId } = session;
    const text = '同一区间内增函数的函数值随自变量增大而增大。';
    const material = store.importMaterial({
      projectId,
      displayName: '纲要.md',
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
    const knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    store.savePlanVersion(projectId, 1, 'confirmed', {
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
      basis: '测试',
      confirmedTaskKnowledgeIds: [knowledgeId],
    });
    const bundle = store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text, conditions: '同一区间' }],
      [],
    );
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '增函数',
      bundleId: bundle.bundleId,
      statementIds: [bundle.bundle.statements[0]!.statementId],
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    store.reviewLesson({ projectId, lessonId, version: 1, decision: 'approved', note: '' });
    store.publishLesson({ projectId, lessonId, version: 1 });
    attachFormalLessonDocument(session, lessonId, 1);
    execution = {
      inspect: vi.fn(async () => facts),
      render: vi.fn(async (plan, _document, _assets, options) => {
        await options.onStage?.('capturing');
        for (const segment of plan.segments)
          if (!options.resumeSegments?.has(segment.index))
            await options.onSegment?.(segment.index, Uint8Array.of(segment.index + 1));
        await options.onStage?.('encoding');
        return {
          bytes,
          sha256: hash(bytes),
          byteLength: bytes.length,
          playable: true,
          runtimes: facts,
          reusedSegments: options.resumeSegments?.size ?? 0,
          capturedSegments: plan.segments.length,
          evidence: {
            mode: 'closed-scene-projection',
            interactionPreserved: false,
            audioPresent: false,
            container: 'mp4',
            videoCodec: 'h264',
            pixelFormat: 'yuv420p',
            width: plan.encoding.width,
            height: plan.encoding.height,
            durationSeconds: plan.totalDurationMs / 1000,
            frameCount: 40,
            decodedFrames: 40,
            ffprobeVerified: true,
            fullDecodeVerified: true,
          },
        };
      }),
    };
  });
  afterEach(async () => {
    for (const task of session.store.mp4.list(session.projectId))
      await waitForMp4Task(session.projectId, task.job.jobId);
    closeProject();
    rmSync(directory, { recursive: true, force: true });
  });
  it('captures durable bytes and publishes a checked downloadable result without a duplicate nonce dispatch', async () => {
    const [first, duplicate] = await Promise.all([
      startMp4Task(session, command(), execution),
      startMp4Task(session, command(), execution),
    ]);
    expect(first.job.jobId).toBe(duplicate.job.jobId);
    await waitForMp4Task(session.projectId, first.job.jobId);
    const task = readMp4Tasks(session)[0]!;
    expect(task.job.state).toBe('succeeded');
    expect(execution.render).toHaveBeenCalledOnce();
    expect(session.store.mp4.segments(task).size).toBe(task.plan.segments.length);
    expect([...readLessonExport(session, lessonId, 1, 'mp4', task.result!.sha256).bytes]).toEqual([
      ...bytes,
    ]);
    await expect(
      startMp4Task(session, { ...command(), version: 2 }, execution),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it.runIf(process.env.SEW_RUN_MP4_INTEGRATION === '1')(
    'publishes and downloads a real reviewed lesson through the durable service using native runtimes',
    async () => {
      const native = { inspect: nativeInspectMp4Runtime, render: nativeRenderMp4 };
      const created = await startMp4Task(
        session,
        command('mp4-native-reviewed-publication'),
        native,
      );
      await waitForMp4Task(session.projectId, created.job.jobId);
      const task = readMp4Tasks(session)[0]!;
      expect(task.job.failure).toBeNull();
      expect(task.job.state).toBe('succeeded');
      expect(task.prepared?.evidence.fullDecodeVerified).toBe(true);
      const result = task.result!;
      const downloaded = readLessonExport(session, lessonId, 1, 'mp4', result.sha256);
      expect(hash(downloaded.bytes)).toBe(result.sha256);
      expect(downloaded.bytes.length).toBe(result.byteLength);
      expect(session.store.mp4.segments(task).size).toBe(task.plan.segments.length);
      const evidenceDir = join(process.cwd(), 'output', 'mp4-runtime-tests');
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'reviewed-lesson-publication.mp4'), downloaded.bytes);
      writeFileSync(
        join(evidenceDir, 'reviewed-lesson-publication.json'),
        `${JSON.stringify(
          {
            scope:
              'reviewed source -> durable job -> checkpoint bytes -> encode -> full decode -> publication -> checked download',
            result,
            evidence: task.prepared!.evidence,
            checkpoints: task.job.completedSegments,
            runtimes: task.plan.runtimes,
            state: task.job.state,
          },
          null,
          2,
        )}\n`,
      );
    },
    180_000,
  );
  it('blocks missing runtime with no renderer call and allows explicit repaired-runtime retry', async () => {
    const missing: Mp4RuntimeInspection = {
      ...facts,
      ready: false,
      gaps: ['ffmpeg'],
      runtimes: facts.runtimes.map((item) =>
        item.kind === 'ffmpeg'
          ? {
              ...item,
              path: null,
              version: null,
              sha256: null,
              available: false,
              reason: 'ffmpeg 未安装',
            }
          : item,
      ),
    };
    execution.inspect.mockResolvedValue(missing);
    const created = await startMp4Task(session, command(), execution);
    await waitForMp4Task(session.projectId, created.job.jobId);
    let task = readMp4Tasks(session)[0]!;
    expect(task.job.state).toBe('blocked');
    expect(execution.render).not.toHaveBeenCalled();
    execution.inspect.mockResolvedValue(facts);
    await actionMp4Task(
      session,
      { scope: scope(), jobId: task.job.jobId, expectedRevision: task.revision, action: 'resume' },
      execution,
    );
    await waitForMp4Task(session.projectId, task.job.jobId);
    task = readMp4Tasks(session)[0]!;
    expect(task.job.state).toBe('succeeded');
  });
  it('persists a checkpoint on failure and reuses only verified bytes after explicit resume', async () => {
    const normal = execution.render.getMockImplementation()!;
    execution.render.mockImplementationOnce(async (_plan, _document, _assets, options) => {
      await options.onStage?.('capturing');
      await options.onSegment?.(0, Uint8Array.of(1));
      throw new Error('interrupted fixture');
    });
    const created = await startMp4Task(session, command(), execution);
    await waitForMp4Task(session.projectId, created.job.jobId);
    const task = readMp4Tasks(session)[0]!;
    expect(task.job.failure?.class).toBe('result-unknown');
    execution.render.mockImplementation(normal);
    await actionMp4Task(
      session,
      { scope: scope(), jobId: task.job.jobId, expectedRevision: task.revision, action: 'resume' },
      execution,
    );
    await waitForMp4Task(session.projectId, task.job.jobId);
    expect(execution.render.mock.calls.at(-1)![3].resumeSegments?.size).toBe(1);
    expect(readMp4Tasks(session)[0]!.job.state).toBe('succeeded');
  });
  it('retains cancellation against a renderer returning late and never publishes the late bytes', async () => {
    let release!: () => void;
    const normal = execution.render.getMockImplementation()!;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    execution.render.mockImplementation(async (...args) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return normal(...args);
    });
    const created = await startMp4Task(session, command(), execution);
    await started;
    const task = session.store.mp4.get(session.projectId, created.job.jobId)!;
    await actionMp4Task(
      session,
      { scope: scope(), jobId: task.job.jobId, expectedRevision: task.revision, action: 'cancel' },
      execution,
    );
    release();
    await waitForMp4Task(session.projectId, task.job.jobId);
    expect(readMp4Tasks(session)[0]!.job.state).toBe('cancelled');
    expect(existsSync(join(directory, 'exports', task.plan.output.fileName))).toBe(false);
  });
  it('reconciles a durable orphan as unknown without redispatching, and refuses corrupt checkpoints', async () => {
    const created = await startMp4Task(session, command(), execution);
    await waitForMp4Task(session.projectId, created.job.jobId);
    const finished = readMp4Tasks(session)[0]!;
    const db = createNodeSqliteDriver().open(session.store.databaseFile);
    const orphan = {
      ...finished,
      result: null,
      prepared: null,
      job: { ...finished.job, state: 'encoding' },
    };
    db.prepare('UPDATE mp4_export_jobs SET task_json=? WHERE job_id=?').run(
      JSON.stringify(orphan),
      finished.job.jobId,
    );
    const unknown = readMp4Tasks(session)[0]!;
    expect(unknown.job.failure?.class).toBe('result-unknown');
    expect(execution.render).toHaveBeenCalledOnce();
    db.prepare('UPDATE mp4_export_segments SET bytes=? WHERE job_id=?').run(
      Uint8Array.of(2),
      unknown.job.jobId,
    );
    db.close();
    await expect(
      actionMp4Task(
        session,
        {
          scope: scope(),
          jobId: unknown.job.jobId,
          expectedRevision: unknown.revision,
          action: 'resume',
        },
        execution,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(execution.render).toHaveBeenCalledOnce();
  });
  it('reconciles a fully decoded publication receipt after a crash without invoking or requiring runtimes again', async () => {
    const created = await startMp4Task(session, command(), execution);
    await waitForMp4Task(session.projectId, created.job.jobId);
    const finished = readMp4Tasks(session)[0]!;
    const db = createNodeSqliteDriver().open(session.store.databaseFile);
    const orphan = { ...finished, result: null, job: { ...finished.job, state: 'encoding' } };
    db.prepare('UPDATE mp4_export_jobs SET task_json=? WHERE job_id=?').run(
      JSON.stringify(orphan),
      finished.job.jobId,
    );
    db.close();
    const unknown = readMp4Tasks(session)[0]!;
    execution.inspect.mockRejectedValue(new Error('runtime no longer installed'));
    const recovered = await actionMp4Task(
      session,
      {
        scope: scope(),
        jobId: unknown.job.jobId,
        expectedRevision: unknown.revision,
        action: 'resume',
      },
      execution,
    );
    expect(recovered.job.state).toBe('succeeded');
    expect(recovered.result?.sha256).toBe(finished.result?.sha256);
    expect(execution.render).toHaveBeenCalledOnce();
    expect(execution.inspect).toHaveBeenCalledTimes(2);
  });
});
