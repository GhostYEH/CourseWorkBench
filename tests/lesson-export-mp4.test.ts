import { describe, expect, it } from 'vitest';
import type { PlanElementDto, PlanSceneDto } from '@sew/study-contracts';
import {
  MP4_DELIVERY_STATUS,
  MP4_EXPORT_FORMAT,
  MP4_EXPORT_VERSION,
  MP4_FAILURE_CLASSES,
  MP4_FAILURE_DISPOSITION,
  MP4_JOB_EVENTS,
  MP4_JOB_STATES,
  MP4_RECOVERY_ACTIONS,
  MP4_RUNTIME_KINDS,
  MP4_RUNTIME_STATUS,
  applyMp4JobEvent,
  buildMp4RenderPlan,
  createMp4RenderJob,
  mp4BlockingRuntimes,
  mp4FailureIsResumable,
  mp4JobAllowedEvents,
  mp4JobProgress,
  mp4JobResultView,
  mp4PlanDigestOf,
  mp4PlanMatchesScenes,
  mp4RenderPlanDigest,
  mp4TrustedSegments,
  normalizeMp4Runtimes,
  recoverMp4Job,
  type Mp4EncodingProfile,
  type Mp4RenderJob,
  type Mp4RenderPlan,
  type Mp4RecoveryFacts,
  type Mp4RuntimeDeclaration,
} from '../packages/study-domain/src/lesson-export-mp4';
import { scenePlanDigest } from '../packages/study-domain/src/scene-plan';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

/** StudyError 把机器可判定的 reason 放在 details（message 是给用户看的中文文案）。 */
const reasonOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    const record = error as { details?: Record<string, unknown> };
    return typeof record?.details?.['reason'] === 'string'
      ? record.details['reason']
      : '#no-reason';
  }
  return 'no-error';
};

const encoding: Mp4EncodingProfile = {
  container: 'mp4',
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  width: 1920,
  height: 1080,
  fps: 30,
  constantRateFactor: 23,
  fastStart: true,
  audio: { codec: 'aac', sampleRate: 48_000 },
};

type RuntimeOverride = Partial<Mp4RuntimeDeclaration> & { kind: Mp4RuntimeDeclaration['kind'] };

const runtime = (overrides: RuntimeOverride): Mp4RuntimeDeclaration => {
  const pick = <K extends keyof Mp4RuntimeDeclaration>(
    key: K,
    fallback: Mp4RuntimeDeclaration[K],
  ): Mp4RuntimeDeclaration[K] =>
    (key in overrides ? overrides[key] : fallback) as Mp4RuntimeDeclaration[K];
  const expectedDigest = pick('expectedDigest', SHA_A);
  return {
    kind: overrides.kind,
    reference: pick('reference', overrides.kind),
    required: pick('required', true),
    minVersion: pick('minVersion', '120.0.0'),
    expectedDigest,
    actualVersion: pick('actualVersion', '121.0.0'),
    actualDigest: pick('actualDigest', expectedDigest),
    status: pick('status', 'available'),
    note: pick('note', ''),
  };
};

const readyRuntimes = (): Mp4RuntimeDeclaration[] => [
  runtime({ kind: 'chromium', expectedDigest: SHA_A, actualDigest: SHA_A }),
  runtime({ kind: 'ffmpeg', expectedDigest: SHA_B, actualDigest: SHA_B }),
  runtime({
    kind: 'formula-runtime',
    reference: 'katex',
    required: false,
    minVersion: null,
    expectedDigest: null,
    actualDigest: null,
    actualVersion: '0.16.11',
    status: 'missing',
    note: '公式渲染运行时未安装，导出的视频里公式以纯文本呈现',
  }),
];

const element = (overrides: Partial<PlanElementDto> = {}): PlanElementDto => ({
  elementId: 'el_text_1',
  kind: 'text',
  text: '物体质量与加速度的关系',
  assetRef: null,
  left: 100,
  top: 100,
  width: 600,
  height: 120,
  style: { fontSize: 24, color: '#232323', bold: false, italic: false, align: 'left' },
  ...overrides,
});

const slide = (sceneId: string, text: string): PlanSceneDto => ({
  sceneId,
  kind: 'slide',
  title: `场景 ${sceneId}`,
  statementId: 'st_1',
  questionId: null,
  knowledgeIds: ['kp_1'],
  elements: [element({ text })],
  note: '',
});

const scenes: PlanSceneDto[] = [
  slide('scene_slide_1', '第一段正文'),
  slide('scene_slide_2', '第二段长一些的内容，用来验证时长随正文量增长'),
];

const identity = (items: PlanSceneDto[]) => ({
  projectId: 'proj_mp4',
  lessonId: 'lesson_1',
  lessonVersion: 2,
  bundleId: 'bundle_1',
  title: '视频导出测试课件',
  planDigest: scenePlanDigest({
    lessonId: 'lesson_1',
    lessonVersion: 2,
    bundleId: 'bundle_1',
    scenes: items,
  }),
  documentDigest: SHA_C,
  exportedDocumentDigest: SHA_D,
});

const buildPlan = (
  items: PlanSceneDto[] = scenes,
  runtimes: Mp4RuntimeDeclaration[] = readyRuntimes(),
): Mp4RenderPlan =>
  buildMp4RenderPlan({
    identity: identity(items),
    scenes: items,
    encoding,
    canvas: { viewportSize: 1000, viewportRatio: 0.5625 },
    runtimes,
    generatedAt: '2026-10-07T00:00:00.000Z',
  });

const newJob = (plan: Mp4RenderPlan = buildPlan()): Mp4RenderJob =>
  createMp4RenderJob({ jobId: 'job_1', requestId: 'req_1', plan, at: '2026-10-07T00:00:00.000Z' });

const advanceToCapturing = (plan: Mp4RenderPlan = buildPlan()): Mp4RenderJob => {
  let job = applyMp4JobEvent(
    newJob(plan),
    'begin-preparation',
    { at: '2026-10-07T00:00:01.000Z' },
    plan,
  );
  job = applyMp4JobEvent(
    job,
    'resources-verified',
    { at: '2026-10-07T00:00:02.000Z', blockingRuntimes: [] },
    plan,
  );
  return applyMp4JobEvent(job, 'begin-capture', { at: '2026-10-07T00:00:03.000Z' }, plan);
};

const captureAll = (plan: Mp4RenderPlan, digests: string[] = [SHA_A, SHA_B]): Mp4RenderJob => {
  let job = advanceToCapturing(plan);
  for (let index = 0; index < plan.segments.length; index += 1) {
    job = applyMp4JobEvent(
      job,
      'segment-captured',
      {
        at: `2026-10-07T00:00:1${index}.000Z`,
        segmentIndex: index,
        artifact: { byteLength: 4096 * (index + 1), sha256: digests[index]! },
      },
      plan,
    );
  }
  job = applyMp4JobEvent(job, 'capture-completed', { at: '2026-10-07T00:01:00.000Z' }, plan);
  return applyMp4JobEvent(job, 'begin-encoding', { at: '2026-10-07T00:01:01.000Z' }, plan);
};

const artifactsByIndex = (job: Mp4RenderJob): Map<number, string> =>
  new Map(job.completedSegments.map((artifact) => [artifact.index, artifact.sha256]));

const recovery = (input: {
  job: Mp4RenderJob;
  plan: Mp4RenderPlan;
  runtimes: () => Mp4RuntimeDeclaration[];
  actualOverride?: Map<number, string>;
  outputOnDisk?: { exists: boolean; sha256: string | null; byteLength: number | null };
  currentPlanDigest?: string | null;
}): Mp4RecoveryFacts => ({
  job: input.job,
  plan: input.plan,
  runtimes: input.runtimes(),
  actualSegmentDigests: input.actualOverride ?? artifactsByIndex(input.job),
  outputOnDisk: input.outputOnDisk ?? { exists: false, sha256: null, byteLength: null },
  currentPlanDigest: input.currentPlanDigest ?? input.plan.identity.planDigest,
  at: '2026-10-07T01:00:00.000Z',
});

describe('mp4 render plan (OMA-071)', () => {
  it('declares the enum surface the contract needs and keeps the failure map total', () => {
    expect(MP4_EXPORT_VERSION).toBe(1);
    expect(MP4_EXPORT_FORMAT).toBe('mp4');
    expect(MP4_RUNTIME_KINDS).toContain('chromium');
    expect(MP4_RUNTIME_KINDS).toContain('ffmpeg');
    expect(MP4_RUNTIME_STATUS).toEqual(['available', 'missing', 'mismatched']);
    expect(MP4_JOB_STATES).toEqual([
      'draft',
      'queued',
      'preparing',
      'blocked',
      'capturing',
      'encoding',
      'succeeded',
      'failed',
      'cancelled',
    ]);
    expect(MP4_RECOVERY_ACTIONS).toContain('resume-from-segment');
    expect(MP4_DELIVERY_STATUS).toEqual(['none', 'partial', 'delivered']);
    for (const failure of MP4_FAILURE_CLASSES) {
      expect(['recoverable', 'requires-replan', 'needs-attention', 'terminal']).toContain(
        MP4_FAILURE_DISPOSITION[failure],
      );
    }
    expect(mp4FailureIsResumable('browser-crash')).toBe(true);
    expect(mp4FailureIsResumable('artifact-digest-mismatch')).toBe(false);
    expect(MP4_JOB_EVENTS.length).toBeGreaterThan(8);
  });

  it('requires real evidence for each declared runtime and rejects non-portable references', () => {
    expect(reasonOf(() => normalizeMp4Runtimes([]))).toBe('mp4_runtimes_not_declared');
    expect(
      reasonOf(() =>
        normalizeMp4Runtimes([runtime({ kind: 'chromium', reference: 'https://cdn/chrome.exe' })]),
      ),
    ).toBe('mp4_runtime_reference_is_url');
    expect(
      reasonOf(() =>
        normalizeMp4Runtimes([runtime({ kind: 'chromium', reference: 'D:\\tools\\chrome.exe' })]),
      ),
    ).toBe('mp4_runtime_reference_is_absolute');
    expect(
      reasonOf(() =>
        normalizeMp4Runtimes([runtime({ kind: 'ffmpeg', reference: '/opt/bin/ffmpeg' })]),
      ),
    ).toBe('mp4_runtime_reference_is_absolute');
    // 宣称 available 却没有任何实际证据：空心「资源已就绪」被拒绝
    expect(
      reasonOf(() =>
        normalizeMp4Runtimes([
          runtime({ kind: 'chromium', actualVersion: null, actualDigest: null }),
        ]),
      ),
    ).toBe('mp4_runtime_available_without_evidence');
    // 实际摘要与期望摘要不符却按 available 登记：不允许拿错版本运行时冒充就绪
    expect(
      reasonOf(() => normalizeMp4Runtimes([runtime({ kind: 'chromium', actualDigest: SHA_B })])),
    ).toBe('mp4_runtime_digest_mismatch_declared_available');
    // 缺口必须带说明
    expect(
      reasonOf(() =>
        normalizeMp4Runtimes([
          runtime({
            kind: 'chromium',
            status: 'missing',
            note: '',
            actualVersion: null,
            actualDigest: null,
          }),
        ]),
      ),
    ).toBe('mp4_runtime_gap_note_missing');
    expect(
      reasonOf(() =>
        normalizeMp4Runtimes([runtime({ kind: 'chromium' }), runtime({ kind: 'chromium' })]),
      ),
    ).toBe('mp4_runtime_duplicate');
    expect(
      reasonOf(() =>
        normalizeMp4Runtimes([runtime({ kind: 'chromium', actualDigest: 'not-a-hash' })]),
      ),
    ).toBe('mp4_runtime_digest_invalid');
    expect(normalizeMp4Runtimes(readyRuntimes())).toHaveLength(3);
    // available 的可选增强资源也要有版本证据
    expect(
      reasonOf(() =>
        normalizeMp4Runtimes([
          ...readyRuntimes(),
          runtime({
            kind: 'font',
            reference: 'Microsoft YaHei',
            required: false,
            actualVersion: null,
            actualDigest: null,
          }),
        ]),
      ),
    ).toBe('mp4_runtime_available_without_evidence');
  });

  it('lists blocking runtimes item by item instead of pretending readiness', () => {
    // 可选资源缺失不阻塞（note 保留给人读）
    const gaps = mp4BlockingRuntimes(readyRuntimes());
    expect(gaps).toHaveLength(0);
    // 必需资源 mismatched/missing 才出现在阻塞清单
    const withMismatch = [
      runtime({ kind: 'chromium' }),
      runtime({
        kind: 'ffmpeg',
        status: 'mismatched',
        note: '实际摘要与安装清单不符',
        actualDigest: SHA_C,
      }),
    ];
    expect(mp4BlockingRuntimes(withMismatch).map((item) => item.reference)).toEqual(['ffmpeg']);
    const withMissing = [
      runtime({
        kind: 'chromium',
        status: 'missing',
        note: '未安装 Chromium',
        actualVersion: null,
        actualDigest: null,
      }),
      runtime({ kind: 'ffmpeg', expectedDigest: SHA_B, actualDigest: SHA_B }),
    ];
    expect(mp4BlockingRuntimes(withMissing).map((item) => item.reference)).toEqual(['chromium']);
  });

  it('builds a per-scene timeline with portable output paths and a deterministic digest', () => {
    const plan = buildPlan();
    expect(plan.segments.map((segment) => segment.sceneId)).toEqual([
      'scene_slide_1',
      'scene_slide_2',
    ]);
    expect(plan.segments[0]!.startMs).toBe(0);
    expect(plan.segments[1]!.startMs).toBe(plan.segments[0]!.durationMs);
    expect(plan.totalDurationMs).toBe(plan.segments[0]!.durationMs + plan.segments[1]!.durationMs);
    // 时长由可读正文量估算：内容更长的场景不短于内容更短的场景
    expect(plan.segments[1]!.durationMs).toBeGreaterThanOrEqual(plan.segments[0]!.durationMs);
    expect(
      plan.segments.every((segment) => segment.durationMs >= 4000 && segment.durationMs <= 60_000),
    ).toBe(true);
    expect(plan.segments.every((segment) => /^[a-f0-9]{64}$/.test(segment.sceneDigest))).toBe(true);
    expect(plan.output.fileName).toBe('lesson-lesson_1-v2.mp4');
    expect(plan.output.directory).toBe('exports/lesson_1-v2');
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(mp4RenderPlanDigest({ ...plan, digest: '' })).toBe(plan.digest);
    expect(buildPlan().digest).toBe(plan.digest);
    expect(mp4PlanMatchesScenes(plan, scenes)).toBe(true);
    expect(
      mp4PlanDigestOf({ lessonId: 'lesson_1', lessonVersion: 2, bundleId: 'bundle_1', scenes }),
    ).toBe(plan.identity.planDigest);
  });

  it('refuses an encoding profile that could not produce a playable file', () => {
    const base = {
      scenes,
      canvas: { viewportSize: 1000, viewportRatio: 0.5625 },
      runtimes: readyRuntimes(),
    };
    const attempt = (
      override: Partial<Mp4RenderPlan['encoding']>,
      identityOverride?: unknown,
    ): string =>
      reasonOf(() =>
        buildMp4RenderPlan({
          ...base,
          encoding: { ...encoding, ...override },
          identity: (identityOverride as Mp4RenderPlan['identity']) ?? identity(scenes),
        }),
      );
    expect(attempt({ width: 1921 })).toBe('mp4_resolution_invalid');
    expect(attempt({ width: 7680, height: 4320 })).toBe('mp4_resolution_too_large');
    expect(attempt({ fps: 240 })).toBe('mp4_fps_invalid');
    expect(attempt({ constantRateFactor: 90 })).toBe('mp4_crf_invalid');
    expect(attempt({ fastStart: false as true })).toBe('mp4_fast_start_required');
    expect(attempt({ videoCodec: 'hevc' as 'h264' })).toBe('mp4_encoding_profile_unsupported');
    expect(
      reasonOf(() =>
        buildMp4RenderPlan({
          ...base,
          encoding,
          identity: identity([]),
          scenes: [],
          runtimes: readyRuntimes(),
        }),
      ),
    ).toBe('mp4_plan_has_no_scenes');
    const drifted = { ...identity(scenes), planDigest: 'f'.repeat(64) };
    expect(
      reasonOf(() =>
        buildMp4RenderPlan({ ...base, encoding, identity: drifted, runtimes: readyRuntimes() }),
      ),
    ).toBe('mp4_plan_digest_mismatch');
  });
});

describe('mp4 job state machine (OMA-071 failure recovery)', () => {
  it('walks the happy path to a verified playable deliverable', () => {
    const plan = buildPlan();
    let job = advanceToCapturing(plan);
    expect(job.state).toBe('capturing');
    job = applyMp4JobEvent(
      job,
      'segment-captured',
      {
        at: '2026-10-07T00:00:04.000Z',
        segmentIndex: 0,
        artifact: { byteLength: 4096, sha256: SHA_A },
      },
      plan,
    );
    expect(job.nextSegmentIndex).toBe(1);
    expect(job.delivery.status).toBe('partial');
    job = applyMp4JobEvent(
      job,
      'segment-captured',
      {
        at: '2026-10-07T00:00:05.000Z',
        segmentIndex: 1,
        artifact: { byteLength: 8192, sha256: SHA_B },
      },
      plan,
    );
    job = applyMp4JobEvent(job, 'capture-completed', { at: '2026-10-07T00:00:06.000Z' }, plan);
    job = applyMp4JobEvent(job, 'begin-encoding', { at: '2026-10-07T00:00:07.000Z' }, plan);
    expect(job.state).toBe('encoding');
    expect(mp4JobProgress(job, plan)).toBeGreaterThan(0.5);
    job = applyMp4JobEvent(
      job,
      'encoding-completed',
      {
        at: '2026-10-07T00:00:08.000Z',
        output: {
          fileName: plan.output.fileName,
          byteLength: 999_999,
          sha256: SHA_C,
          playable: true,
        },
      },
      plan,
    );
    expect(job.state).toBe('succeeded');
    expect(job.delivery).toEqual({
      status: 'delivered',
      fileName: plan.output.fileName,
      byteLength: 999_999,
      sha256: SHA_C,
      playable: true,
    });
    expect(mp4JobProgress(job, plan)).toBe(1);
    expect(mp4JobResultView(job, plan)).toMatchObject({
      delivered: true,
      destination: `exports/lesson_1-v2/${plan.output.fileName}`,
    });
    expect(job.events.map((entry) => entry.event)).toEqual([
      'enqueue',
      'begin-preparation',
      'resources-verified',
      'begin-capture',
      'segment-captured',
      'segment-captured',
      'capture-completed',
      'begin-encoding',
      'encoding-completed',
    ]);
  });

  it('refuses to declare success without a playable, verifiable artifact', () => {
    const plan = buildPlan();
    const job = captureAll(plan);
    expect(
      reasonOf(() =>
        applyMp4JobEvent(
          job,
          'encoding-completed',
          {
            at: 'x',
            output: {
              fileName: plan.output.fileName,
              byteLength: 10,
              sha256: SHA_A,
              playable: false,
            },
          },
          plan,
        ),
      ),
    ).toBe('mp4_output_not_playable');
    expect(reasonOf(() => applyMp4JobEvent(job, 'encoding-completed', { at: 'x' }, plan))).toBe(
      'mp4_output_evidence_missing',
    );
    expect(
      reasonOf(() =>
        applyMp4JobEvent(
          job,
          'encoding-completed',
          {
            at: 'x',
            output: { fileName: 'C:/out.mp4', byteLength: 10, sha256: SHA_A, playable: true },
          },
          plan,
        ),
      ),
    ).toBe('mp4_output_path_not_portable');
    expect(
      reasonOf(() =>
        applyMp4JobEvent(
          job,
          'encoding-completed',
          {
            at: 'x',
            output: {
              fileName: plan.output.fileName,
              byteLength: 0,
              sha256: SHA_A,
              playable: true,
            },
          },
          plan,
        ),
      ),
    ).toBe('mp4_output_evidence_missing');
    expect(job.state).toBe('encoding');
    expect(mp4JobResultView(job, plan).delivered).toBe(false);
  });

  it('never skips the runtime gate and never accepts out-of-order or unverified segments', () => {
    const plan = buildPlan();
    const queued = newJob(plan);
    // 排队中不能直接采集或核验：必须先 begin-preparation
    expect(reasonOf(() => applyMp4JobEvent(queued, 'begin-capture', { at: 'x' }, plan))).toBe(
      'mp4_illegal_transition',
    );
    expect(
      reasonOf(() =>
        applyMp4JobEvent(queued, 'resources-verified', { at: 'x', blockingRuntimes: [] }, plan),
      ),
    ).toBe('mp4_illegal_transition');
    const preparing = applyMp4JobEvent(queued, 'begin-preparation', { at: 'x' }, plan);
    // 运行时不到位时不能宣称核验通过
    const gaps = mp4BlockingRuntimes([
      runtime({
        kind: 'ffmpeg',
        status: 'missing',
        note: '缺少 ffmpeg',
        actualVersion: null,
        actualDigest: null,
      }),
    ]);
    expect(
      reasonOf(() =>
        applyMp4JobEvent(
          preparing,
          'resources-verified',
          { at: 'x', blockingRuntimes: gaps },
          plan,
        ),
      ),
    ).toBe('mp4_runtime_unverified');
    // 缺口 → blocked；blocked 不在 begin-capture 的允许来源里（界面据此禁用）
    const blocked = applyMp4JobEvent(
      preparing,
      'resources-unavailable',
      { at: 'x', blockingRuntimes: gaps },
      plan,
    );
    expect(blocked.state).toBe('blocked');
    expect(blocked.failure?.class).toBe('runtime-missing');
    expect(mp4JobAllowedEvents(blocked)).toEqual(
      expect.arrayContaining(['begin-preparation', 'fail', 'cancel']),
    );
    expect(mp4JobAllowedEvents(blocked)).not.toContain('begin-capture');
    expect(reasonOf(() => applyMp4JobEvent(blocked, 'begin-capture', { at: 'x' }, plan))).toBe(
      'mp4_illegal_transition',
    );
    // 采集：片段必须连续且带可复验证据
    const capturing = applyMp4JobEvent(
      advanceToCapturing(plan),
      'segment-captured',
      { at: 'x', segmentIndex: 0, artifact: { byteLength: 100, sha256: SHA_A } },
      plan,
    );
    expect(
      reasonOf(() =>
        applyMp4JobEvent(
          capturing,
          'segment-captured',
          { at: 'x', segmentIndex: 0, artifact: { byteLength: 100, sha256: SHA_A } },
          plan,
        ),
      ),
    ).toBe('mp4_segment_out_of_order');
    expect(
      reasonOf(() =>
        applyMp4JobEvent(
          capturing,
          'segment-captured',
          { at: 'x', segmentIndex: 2, artifact: { byteLength: 100, sha256: SHA_A } },
          plan,
        ),
      ),
    ).toBe('mp4_segment_out_of_order');
    expect(
      reasonOf(() =>
        applyMp4JobEvent(
          capturing,
          'segment-captured',
          { at: 'x', segmentIndex: 1, artifact: { byteLength: 100, sha256: 'zz' } },
          plan,
        ),
      ),
    ).toBe('mp4_segment_artifact_unverified');
    expect(
      reasonOf(() => applyMp4JobEvent(capturing, 'capture-completed', { at: 'x' }, plan)),
    ).toBe('mp4_capture_incomplete');
    expect(reasonOf(() => applyMp4JobEvent(capturing, 'begin-encoding', { at: 'x' }, plan))).toBe(
      'mp4_encode_needs_all_segments',
    );
    // 终态不再被改写
    const succeeded = applyMp4JobEvent(
      captureAll(plan),
      'encoding-completed',
      {
        at: 'x',
        output: { fileName: plan.output.fileName, byteLength: 10, sha256: SHA_C, playable: true },
      },
      plan,
    );
    expect(reasonOf(() => applyMp4JobEvent(succeeded, 'cancel', { at: 'x' }, plan))).toBe(
      'mp4_illegal_transition',
    );
    expect(
      reasonOf(() =>
        applyMp4JobEvent(
          succeeded,
          'fail',
          {
            at: 'x',
            failure: { class: 'timeout', message: 'x', occurredAt: 'x', segmentIndex: null },
          },
          plan,
        ),
      ),
    ).toBe('mp4_illegal_transition');
  });

  it('records a classified failure and keeps the completed prefix trusted only when digests verify', () => {
    const plan = buildPlan();
    const capturing = applyMp4JobEvent(
      advanceToCapturing(plan),
      'segment-captured',
      { at: 'x', segmentIndex: 0, artifact: { byteLength: 4096, sha256: SHA_A } },
      plan,
    );
    const failed = applyMp4JobEvent(
      capturing,
      'fail',
      {
        at: 'x',
        failure: {
          class: 'browser-crash',
          message: 'Chromium 渲染进程崩溃',
          occurredAt: 'x',
          segmentIndex: 1,
        },
      },
      plan,
    );
    expect(failed.state).toBe('failed');
    expect(failed.failure).toMatchObject({ class: 'browser-crash', segmentIndex: 1 });
    expect(
      mp4TrustedSegments(failed, plan, { actualSegmentDigests: artifactsByIndex(failed) }),
    ).toHaveLength(1);
    expect(
      mp4TrustedSegments(failed, plan, { actualSegmentDigests: new Map([[0, 'z'.repeat(64)]]) }),
    ).toHaveLength(0);
    const decision = recoverMp4Job(recovery({ job: failed, plan, runtimes: readyRuntimes }));
    expect(decision.action).toBe('resume-from-segment');
    expect(decision.fromSegmentIndex).toBe(1);
    expect(decision.discardSegments).toBe(0);
  });

  it('resumes from the first missing segment after a crash instead of re-rendering everything', () => {
    const plan = buildPlan();
    const afterFirst = applyMp4JobEvent(
      advanceToCapturing(plan),
      'segment-captured',
      { at: 'x', segmentIndex: 0, artifact: { byteLength: 4096, sha256: SHA_A } },
      plan,
    );
    const crashed = applyMp4JobEvent(
      afterFirst,
      'fail',
      {
        at: 'x',
        failure: {
          class: 'browser-crash',
          message: '浏览器崩溃',
          occurredAt: 'x',
          segmentIndex: 1,
        },
      },
      plan,
    );
    const decision = recoverMp4Job(recovery({ job: crashed, plan, runtimes: readyRuntimes }));
    expect(decision.action).toBe('resume-from-segment');
    expect(decision.fromSegmentIndex).toBe(1);
    expect(decision.state).toBe('queued');
    const requeued = applyMp4JobEvent(crashed, 'requeue', { at: 'x' }, plan);
    expect(requeued.attempts).toBe(1);
    expect(requeued.nextSegmentIndex).toBe(1);
    expect(requeued.state).toBe('queued');
    // 续跑重新过运行时门，不跳过核验
    const resumed = applyMp4JobEvent(requeued, 'begin-preparation', { at: 'x' }, plan);
    expect(resumed.state).toBe('preparing');
  });

  it('invalidates segments whose bytes no longer match the recorded digest', () => {
    const plan = buildPlan();
    const job = captureAll(plan, [SHA_A, SHA_B]);
    expect(job.state).toBe('encoding');
    // 第二段在磁盘上被换掉了（断电/覆盖写）
    const decision = recoverMp4Job(
      recovery({
        job,
        plan,
        runtimes: readyRuntimes,
        actualOverride: new Map([
          [0, SHA_A],
          [1, 'e'.repeat(64)],
        ]),
      }),
    );
    expect(decision.action).toBe('resume-from-segment');
    expect(decision.fromSegmentIndex).toBe(1);
    expect(decision.discardSegments).toBe(1);
    expect(decision.reason).toContain('摘要不符');
  });

  it('treats an unknown-outcome interruption as reconcile/publish, never as a blind re-render', () => {
    const plan = buildPlan();
    // 场景 A：编码中被杀进程，磁盘上其实已有产物 → 对账发布，不重渲
    const encodingJob = captureAll(plan);
    const published = recoverMp4Job(
      recovery({
        job: encodingJob,
        plan,
        runtimes: readyRuntimes,
        outputOnDisk: { exists: true, sha256: SHA_C, byteLength: 999_999 },
      }),
    );
    expect(published.action).toBe('publish-verified-output');
    expect(published.discardSegments).toBe(0);
    // 场景 B：采集中断且尚无可信片段 → 先复验磁盘现场
    const capturing = applyMp4JobEvent(
      advanceToCapturing(plan),
      'segment-captured',
      { at: 'x', segmentIndex: 0, artifact: { byteLength: 10, sha256: SHA_A } },
      plan,
    );
    const interrupted: Mp4RenderJob = { ...capturing, completedSegments: [], nextSegmentIndex: 0 };
    const reconcile = recoverMp4Job(
      recovery({ job: interrupted, plan, runtimes: readyRuntimes, actualOverride: new Map() }),
    );
    expect(reconcile.action).toBe('reconcile');
    // 场景 C：已成功且磁盘产物与记录一致 → 幂等重发读回既有结果
    const succeeded = applyMp4JobEvent(
      encodingJob,
      'encoding-completed',
      {
        at: 'x',
        output: {
          fileName: plan.output.fileName,
          byteLength: 999_999,
          sha256: SHA_C,
          playable: true,
        },
      },
      plan,
    );
    const verified = recoverMp4Job(
      recovery({
        job: succeeded,
        plan,
        runtimes: readyRuntimes,
        outputOnDisk: { exists: true, sha256: SHA_C, byteLength: 999_999 },
      }),
    );
    expect(verified.action).toBe('none');
    // 宣称成功但磁盘没有产物 → 不能算完成，作废重来
    const lost = recoverMp4Job(recovery({ job: succeeded, plan, runtimes: readyRuntimes }));
    expect(lost.action).toBe('replan');
    expect(lost.reason).toContain('磁盘产物与记录不符');
  });

  it('drops every cached segment when the frozen plan content drifted', () => {
    const plan = buildPlan();
    const job = captureAll(plan);
    const driftedPlanDigest = scenePlanDigest({
      lessonId: 'lesson_1',
      lessonVersion: 2,
      bundleId: 'bundle_1',
      scenes: [slide('scene_slide_1', '第一段正文被改写了')],
    });
    expect(driftedPlanDigest).not.toBe(plan.identity.planDigest);
    const decision = recoverMp4Job(
      recovery({ job, plan, runtimes: readyRuntimes, currentPlanDigest: driftedPlanDigest }),
    );
    expect(decision.action).toBe('replan');
    expect(decision.fromSegmentIndex).toBe(0);
    expect(decision.discardSegments).toBe(2);
    expect(decision.state).toBe('draft');
  });

  it('holds the line on runtime gaps, exhausted attempts and manual-attention failures', () => {
    const plan = buildPlan();
    const prepared = applyMp4JobEvent(newJob(plan), 'begin-preparation', { at: 'x' }, plan);
    const gaps = [
      runtime({
        kind: 'chromium',
        status: 'mismatched',
        note: 'Chromium 摘要与安装清单不符',
        actualDigest: SHA_D,
      }),
    ];
    const blocked = applyMp4JobEvent(
      prepared,
      'resources-unavailable',
      { at: 'x', blockingRuntimes: gaps },
      plan,
    );
    expect(blocked.failure?.class).toBe('runtime-mismatch');
    const decision = recoverMp4Job(
      recovery({ job: blocked, plan, runtimes: () => [...readyRuntimes(), ...gaps] }),
    );
    expect(decision.action).toBe('needs-attention');
    expect(decision.state).toBe('blocked');
    expect(decision.reason).toContain('渲染运行时未到位');

    // 重试次数用尽
    const crashed = applyMp4JobEvent(
      advanceToCapturing(plan),
      'fail',
      {
        at: 'x',
        failure: { class: 'timeout', message: '采集超时', occurredAt: 'x', segmentIndex: 0 },
      },
      plan,
    );
    const exhausted: Mp4RenderJob = { ...crashed, attempts: crashed.maxAttempts };
    const stop = recoverMp4Job(recovery({ job: exhausted, plan, runtimes: readyRuntimes }));
    expect(stop.action).toBe('needs-attention');
    expect(stop.reason).toContain('重试次数已用尽');
    expect(reasonOf(() => applyMp4JobEvent(exhausted, 'requeue', { at: 'x' }, plan))).toBe(
      'mp4_attempts_exhausted',
    );
    // 需要换计划的失败不允许原地 requeue
    const driftedFailure = applyMp4JobEvent(
      advanceToCapturing(plan),
      'fail',
      {
        at: 'x',
        failure: { class: 'plan-drift', message: '计划已变', occurredAt: 'x', segmentIndex: null },
      },
      plan,
    );
    expect(reasonOf(() => applyMp4JobEvent(driftedFailure, 'requeue', { at: 'x' }, plan))).toBe(
      'mp4_failure_not_resumable',
    );
    // 磁盘满是 needs-attention，不当成可自动重试
    const diskFull = applyMp4JobEvent(
      advanceToCapturing(plan),
      'fail',
      {
        at: 'x',
        failure: { class: 'disk-full', message: '磁盘已满', occurredAt: 'x', segmentIndex: 1 },
      },
      plan,
    );
    const diskDecision = recoverMp4Job(recovery({ job: diskFull, plan, runtimes: readyRuntimes }));
    expect(diskDecision.action).toBe('needs-attention');
    expect(MP4_FAILURE_DISPOSITION['disk-full']).toBe('needs-attention');
    // 取消不发布半成品
    const cancelled = applyMp4JobEvent(captureAll(plan), 'cancel', { at: 'x' }, plan);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.delivery.status).toBe('partial');
    expect(mp4JobResultView(cancelled, plan).delivered).toBe(false);
    expect(mp4JobResultView(cancelled, plan).fileName).toBeNull();
  });

  it('reports progress and result gaps honestly while nothing is delivered', () => {
    const plan = buildPlan();
    const queued = newJob(plan);
    expect(queued.state).toBe('queued');
    expect(mp4JobProgress(queued, plan)).toBe(0);
    const capturing = applyMp4JobEvent(
      advanceToCapturing(plan),
      'segment-captured',
      { at: 'x', segmentIndex: 0, artifact: { byteLength: 10, sha256: SHA_A } },
      plan,
    );
    expect(mp4JobProgress(capturing, plan)).toBeLessThan(0.5);
    const view = mp4JobResultView(capturing, plan);
    expect(view.delivered).toBe(false);
    expect(view.destination).toBeNull();
    expect(view.message).toContain('已完成 1/2');
    const blocked = applyMp4JobEvent(
      applyMp4JobEvent(queued, 'begin-preparation', { at: 'x' }, plan),
      'resources-unavailable',
      {
        at: 'x',
        blockingRuntimes: [
          runtime({
            kind: 'ffmpeg',
            status: 'missing',
            note: '未安装 FFmpeg',
            actualVersion: null,
            actualDigest: null,
          }),
        ],
      },
      plan,
    );
    const blockedView = mp4JobResultView(blocked, plan);
    expect(blockedView.delivered).toBe(false);
    expect(blockedView.message).toContain('未安装 FFmpeg');
    expect(JSON.stringify(blockedView)).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});
