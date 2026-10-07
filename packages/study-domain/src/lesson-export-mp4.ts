/**
 * MP4 导出任务（OMA-071）的**计划与状态模型**。
 *
 * 视频导出是这一批导出能力里唯一**不能同步完成**的：它要真实启动 Chromium 逐帧截取课件、
 * 再用 FFmpeg 编码封装成可播放的 MP4，几十秒的课件就可能跑上几分钟，中途必然会遇到
 * 「运行时没装好 / 浏览器崩了 / 编码器退出 / 磁盘写满 / 结果没读到」这些情况。
 * 因此这里给出的不是一个「假装成功」的结果对象，而是一台**可持久化的真实任务状态机**：
 *
 * 1. **资源声明**（acceptance「Chromium/FFmpeg 资源声明」）：`Mp4RuntimeDeclaration` 逐项声明
 *    任务需要的运行时——Chromium 与 FFmpeg 以**符号引用 + 期望摘要 + 期望最低版本**登记，
 *    执行侧读回实际版本/摘要后落到 `actualVersion` / `actualDigest` 与 `status`
 *    （`available` / `missing` / `mismatched`）。声明里不写盘符、不写外部 URL（OMA-072）；
 *    任何 `required` 资源不到位，任务就停在 `blocked` 并逐条给出缺口原因，**不进入采集阶段、
 *    不伪造进度**（这与 HTML 导出把 KaTeX/Three.js 逐项登记为缺口的口径一致）；
 *
 * 2. **时间线与分段**：计划把冻结场景逐条排成片段（segment），时长由该场景的可读正文量
 *    估算（`charactersPerSecond`，带下限与上限），并绑定**该场景的内容摘要**。
 *    分段是失败恢复的单位：每个片段渲染完就是一个有摘要、有字节数的产物条目；
 *
 * 3. **失败恢复**：`applyMp4JobEvent` 是唯一的状态推进入口（非法推进即拒绝），
 *    `recoverMp4Job` 把重启后看到的事实（运行时状态、磁盘上残留的分段产物摘要、
 *    输出文件是否存在、计划是否已漂移）折算成**下一步动作**：
 *    - `resume-from-N`：校验过的已完成片段保留，只从第一个缺失/损坏的片段续跑；
 *    - `requeue`：可重试故障（崩溃、超时）在 `attempts < maxAttempts` 时重新排队；
 *    - `replan`：场景内容或计划摘要已经变了 → 旧检查点整体作废，不能拿旧片段拼成新课件的视频；
 *    - `reconcile`：结果未知（进程被杀、响应丢失）→ 先复验磁盘上的分段摘要再决定，不盲目重发；
 *    - `needs-attention`：磁盘满、编码器不可用这类需要人工处置的失败，停在原地报原因。
 *    失败分类同时决定「已完成片段是否仍然可信」，绝不静默把可疑片段当成可用（RESUME 层同口径）。
 *
 * 纯函数：不 spawn 进程、不启动浏览器、不调用 FFmpeg、不做 IO。字节级渲染/编码由执行侧
 * （render-service 或本地 worker）承担，它把读到的事实交回这里做判定。
 */

import { StudyError, type PlanSceneDto, type ScenePlanDto } from '@sew/study-contracts';
import { canonicalJson } from './classroom';
import { fingerprintOf } from './normalize';
import { planSceneDigest, scenePlanDigest } from './scene-plan';
import { classifyMediaReference } from './lesson-export-pptx';

/** 任务模型版本。 */
export const MP4_EXPORT_VERSION = 1;
/** 导出格式标识：与 contracts 请求扩展后的 `format` 取值一致。 */
export const MP4_EXPORT_FORMAT = 'mp4';

/** 运行时类别。视频导出的两类硬依赖是 Chromium 与 FFmpeg，其余为可选增强。 */
export const MP4_RUNTIME_KINDS = [
  'chromium',
  'ffmpeg',
  'font',
  'formula-runtime',
  'narration-audio',
  'media-decoder',
] as const;
export type Mp4RuntimeKind = (typeof MP4_RUNTIME_KINDS)[number];

/** 运行时状态：到位 / 缺失 / 版本或摘要不符（不符比缺失更危险，必须显式区分）。 */
export const MP4_RUNTIME_STATUS = ['available', 'missing', 'mismatched'] as const;
export type Mp4RuntimeStatus = (typeof MP4_RUNTIME_STATUS)[number];

/** 任务状态机状态。 */
export const MP4_JOB_STATES = [
  'draft',
  'queued',
  'preparing',
  'blocked',
  'capturing',
  'encoding',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type Mp4JobState = (typeof MP4_JOB_STATES)[number];

/** 状态机事件。 */
export const MP4_JOB_EVENTS = [
  'enqueue',
  'begin-preparation',
  'resources-verified',
  'resources-unavailable',
  'begin-capture',
  'segment-captured',
  'capture-completed',
  'begin-encoding',
  'encoding-completed',
  'fail',
  'cancel',
  'requeue',
] as const;
export type Mp4JobEvent = (typeof MP4_JOB_EVENTS)[number];

/**
 * 失败分类。`recoverable` 表示同一份计划可以继续跑（保留已校验片段）；
 * `requires-replan` 表示计划/内容已变，旧片段不可信；`needs-attention` 表示要人工处置环境。
 */
export const MP4_FAILURE_CLASSES = [
  'runtime-missing',
  'runtime-mismatch',
  'browser-crash',
  'encoder-crashed',
  'disk-full',
  'timeout',
  'result-unknown',
  'artifact-digest-mismatch',
  'plan-drift',
  'cancelled-by-user',
] as const;
export type Mp4FailureClass = (typeof MP4_FAILURE_CLASSES)[number];

export type Mp4FailureDisposition =
  'recoverable' | 'requires-replan' | 'needs-attention' | 'terminal';

export const MP4_FAILURE_DISPOSITION: Readonly<Record<Mp4FailureClass, Mp4FailureDisposition>> = {
  'runtime-missing': 'needs-attention',
  'runtime-mismatch': 'needs-attention',
  'browser-crash': 'recoverable',
  'encoder-crashed': 'recoverable',
  'disk-full': 'needs-attention',
  timeout: 'recoverable',
  'result-unknown': 'recoverable',
  'artifact-digest-mismatch': 'requires-replan',
  'plan-drift': 'requires-replan',
  'cancelled-by-user': 'terminal',
};

/** 恢复后要么什么都不做，要么按这一段动作执行；`reconcile` 必须先复验再决定。 */
export const MP4_RECOVERY_ACTIONS = [
  'none',
  'resume-from-segment',
  'requeue',
  'replan',
  'reconcile',
  'needs-attention',
  'publish-verified-output',
] as const;
export type Mp4RecoveryAction = (typeof MP4_RECOVERY_ACTIONS)[number];

/** 交付状态：只有可播放产物落盘并复验通过才算 delivered。 */
export const MP4_DELIVERY_STATUS = ['none', 'partial', 'delivered'] as const;
export type Mp4DeliveryStatus = (typeof MP4_DELIVERY_STATUS)[number];

/** 编码参数：固定 H.264 + MP4 容器（可播放性优先），音频可选。 */
export interface Mp4EncodingProfile {
  readonly container: 'mp4';
  readonly videoCodec: 'h264';
  readonly pixelFormat: 'yuv420p';
  readonly width: number;
  readonly height: number;
  /** 帧率上限 60：视频导出不做高帧率伪装，超过即拒绝。 */
  readonly fps: number;
  readonly constantRateFactor: number;
  readonly fastStart: true;
  readonly audio: { readonly codec: 'aac'; readonly sampleRate: number } | null;
}

export interface Mp4Canvas {
  readonly viewportSize: number;
  readonly viewportRatio: number;
}

/**
 * 单条运行时声明。
 *
 * `reference` 必须是**符号引用**（如 `chromium`、`ffmpeg`、`Microsoft YaHei`、`katex`），
 * 不接受外部 URL 或本机绝对路径——产物与任务记录都不能依赖某一台机器的目录结构。
 * `expectedDigest` 是期望的二进制摘要（由执行侧安装清单给出），`actualDigest`/`actualVersion`
 * 由执行侧读回，两者不符即 `mismatched`。
 */
export interface Mp4RuntimeDeclaration {
  readonly kind: Mp4RuntimeKind;
  readonly reference: string;
  readonly required: boolean;
  readonly minVersion: string | null;
  readonly expectedDigest: string | null;
  readonly actualVersion: string | null;
  readonly actualDigest: string | null;
  readonly status: Mp4RuntimeStatus;
  /** 人类可读的缺口/偏差说明；`available` 时为空串。 */
  readonly note: string;
}

/** 时间线上的一个片段（一个场景 = 一个片段，顺序即场景顺序）。 */
export interface Mp4Segment {
  readonly index: number;
  readonly sceneId: string;
  readonly sceneKind: PlanSceneDto['kind'];
  readonly title: string;
  readonly startMs: number;
  readonly durationMs: number;
  /** 该场景的**内容**摘要：恢复时用它判定旧片段是否仍然可信。 */
  readonly sceneDigest: string;
}

export interface Mp4JobIdentity {
  readonly projectId: string;
  readonly lessonId: string;
  readonly lessonVersion: number;
  readonly bundleId: string;
  readonly title: string;
  /** 冻结计划摘要；片段的 `sceneDigest` 必须能与之对得上。 */
  readonly planDigest: string | null;
  readonly documentDigest: string | null;
  readonly exportedDocumentDigest: string | null;
}

export interface BuildMp4RenderPlanInput {
  readonly identity: Mp4JobIdentity;
  readonly scenes: readonly PlanSceneDto[];
  readonly encoding: Mp4EncodingProfile;
  readonly canvas: Mp4Canvas;
  readonly runtimes: readonly Mp4RuntimeDeclaration[];
  /** 朗读/字幕时长估算口径。 */
  readonly pacing?: {
    readonly charactersPerSecond?: number;
    readonly minSegmentMs?: number;
    readonly maxSegmentMs?: number;
  };
  readonly generatedAt?: string;
}

export interface Mp4RenderPlan {
  readonly planVersion: number;
  readonly format: 'mp4';
  readonly generatedAt: string;
  readonly identity: Mp4JobIdentity;
  readonly encoding: Mp4EncodingProfile;
  readonly canvas: Mp4Canvas;
  readonly segments: readonly Mp4Segment[];
  readonly totalDurationMs: number;
  readonly runtimes: readonly Mp4RuntimeDeclaration[];
  /** 产物落盘的**项目内相对路径**（不写绝对路径）。 */
  readonly output: { readonly directory: string; readonly fileName: string };
  readonly digest: string;
}

/** 已完成片段的磁盘事实（执行侧复验后交回）。 */
export interface Mp4SegmentArtifact {
  readonly index: number;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface Mp4JobFailure {
  readonly class: Mp4FailureClass;
  readonly message: string;
  readonly occurredAt: string;
  readonly segmentIndex: number | null;
}

export interface Mp4RenderJob {
  readonly jobId: string;
  readonly state: Mp4JobState;
  readonly planDigest: string;
  readonly requestedAt: string;
  readonly updatedAt: string;
  /** 幂等号：同一次请求重发读回同一任务，不追加第二个渲染任务。 */
  readonly requestId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** 已完成的**连续**片段前缀之后的第一个待渲染片段；恢复从这里继续。 */
  readonly nextSegmentIndex: number;
  readonly completedSegments: readonly Mp4SegmentArtifact[];
  readonly failure: Mp4JobFailure | null;
  readonly delivery: {
    readonly status: Mp4DeliveryStatus;
    readonly fileName: string | null;
    readonly byteLength: number | null;
    readonly sha256: string | null;
    readonly playable: boolean;
  };
  readonly events: readonly {
    readonly state: Mp4JobState;
    readonly event: Mp4JobEvent;
    readonly at: string;
    readonly note: string;
  }[];
}

const DEFAULT_PACING = { charactersPerSecond: 15, minSegmentMs: 4000, maxSegmentMs: 60_000 };

// ————————————————————————— 声明校验 —————————————————————————

const isSha256 = (value: string | null): boolean => value === null || /^[a-f0-9]{64}$/.test(value);

const assertPortableReference = (reference: string, kind: Mp4RuntimeKind): void => {
  // 运行时引用允许两类可移植形态：符号名（不含 `/`）与包内相对路径。
  if (reference.length === 0 || reference.length > 200) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_runtime_reference_invalid', kind });
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reference) || reference.startsWith('//')) {
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'mp4_runtime_reference_is_url',
      kind,
      reference,
    });
  }
  if (
    /^[a-z]:[\\/]/i.test(reference) ||
    reference.startsWith('\\\\') ||
    reference.startsWith('/')
  ) {
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'mp4_runtime_reference_is_absolute',
      kind,
      reference,
    });
  }
  if (reference.includes('\\')) {
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'mp4_runtime_reference_has_backslash',
      kind,
    });
  }
  if (reference.includes('/')) {
    const segments = reference.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'mp4_runtime_reference_not_portable',
        kind,
      });
    }
  }
};

/**
 * 校验并归一化运行时声明。
 *
 * `status` 与事实必须自洽：宣称 `available` 却没有实际摘要/版本、或 `missing`/`mismatched`
 * 却没有说明文字，都在这里拒绝——不允许用一条空心的「资源已就绪」把任务放进渲染队列。
 */
export const normalizeMp4Runtimes = (
  runtimes: readonly Mp4RuntimeDeclaration[],
): Mp4RuntimeDeclaration[] => {
  if (runtimes.length === 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_runtimes_not_declared' });
  }
  const seen = new Set<string>();
  return runtimes.map((runtime) => {
    assertPortableReference(runtime.reference, runtime.kind);
    const key = `${runtime.kind}:${runtime.reference.toLowerCase()}`;
    if (seen.has(key)) {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'mp4_runtime_duplicate',
        reference: runtime.reference,
      });
    }
    seen.add(key);
    if (!isSha256(runtime.expectedDigest) || !isSha256(runtime.actualDigest)) {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'mp4_runtime_digest_invalid',
        reference: runtime.reference,
      });
    }
    if (runtime.status === 'available') {
      // 两类硬依赖（Chromium / FFmpeg）必须有实际版本 + 实际摘要；可选增强（字体等）至少要有版本。
      const hard = runtime.kind === 'chromium' || runtime.kind === 'ffmpeg';
      if (runtime.actualVersion === null || (hard && runtime.actualDigest === null)) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'mp4_runtime_available_without_evidence',
          reference: runtime.reference,
        });
      }
    }
    if (runtime.status !== 'available' && runtime.note.trim().length === 0) {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'mp4_runtime_gap_note_missing',
        reference: runtime.reference,
      });
    }
    // 声称已到位但实际摘要与期望摘要不符：这是最危险的伪装（拿错版本的 Chromium 渲出的
    // 课件不能算成功），必须走 mismatched 而不是 available。
    if (
      runtime.status === 'available' &&
      runtime.expectedDigest !== null &&
      runtime.actualDigest !== null &&
      runtime.expectedDigest !== runtime.actualDigest
    ) {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'mp4_runtime_digest_mismatch_declared_available',
        reference: runtime.reference,
      });
    }
    return { ...runtime, note: runtime.status === 'available' ? '' : runtime.note };
  });
};

/** 未到位的必需运行时（逐条可见；执行侧据此停在 blocked，不进采集）。 */
export const mp4BlockingRuntimes = (
  runtimes: readonly Mp4RuntimeDeclaration[],
): Mp4RuntimeDeclaration[] =>
  runtimes.filter((runtime) => runtime.required && runtime.status !== 'available');

// ————————————————————————— 时长估算 —————————————————————————

const sceneReadableText = (scene: PlanSceneDto): string => {
  if (scene.kind === 'slide' || scene.kind === 'quiz') {
    const elements = scene.elements.map((element) => element.text).join(' ');
    return `${scene.title} ${elements}`.replace(/<[^>]*>/g, ' ');
  }
  return scene.title;
};

const estimateSegmentMs = (text: string, pacing: typeof DEFAULT_PACING): number => {
  const units = [...text.replace(/\s/g, '')].length;
  const raw = Math.ceil((units / Math.max(1, pacing.charactersPerSecond)) * 1000);
  return Math.min(pacing.maxSegmentMs, Math.max(pacing.minSegmentMs, raw));
};

// ————————————————————————— 计划构建 —————————————————————————

const assertValidEncoding = (encoding: Mp4EncodingProfile): void => {
  const even = (value: number): boolean => Number.isInteger(value) && value > 0;
  if (
    !even(encoding.width) ||
    !even(encoding.height) ||
    encoding.width % 2 ||
    encoding.height % 2
  ) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_resolution_invalid' });
  }
  if (encoding.width * encoding.height > 3840 * 2160) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_resolution_too_large' });
  }
  if (!Number.isInteger(encoding.fps) || encoding.fps < 1 || encoding.fps > 60) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_fps_invalid' });
  }
  if (
    !Number.isInteger(encoding.constantRateFactor) ||
    encoding.constantRateFactor < 0 ||
    encoding.constantRateFactor > 51
  ) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_crf_invalid' });
  }
  if (
    encoding.container !== 'mp4' ||
    encoding.videoCodec !== 'h264' ||
    encoding.pixelFormat !== 'yuv420p'
  ) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_encoding_profile_unsupported' });
  }
  if (encoding.fastStart !== true) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_fast_start_required' });
  }
  if (encoding.audio !== null && encoding.audio.codec !== 'aac') {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_audio_codec_unsupported' });
  }
};

/** 计划内容摘要（与时间戳、与自身摘要字段无关）：同一份计划每次生成同一个 digest，供任务与恢复绑定。 */
export const mp4RenderPlanDigest = (
  plan: Omit<Mp4RenderPlan, 'digest' | 'generatedAt'> | Mp4RenderPlan,
): string => {
  const record = plan as Partial<Mp4RenderPlan>;
  const content = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'digest' && key !== 'generatedAt'),
  );
  return fingerprintOf(canonicalJson(content));
};

/**
 * 由冻结场景 + 编码参数 + 运行时声明构建 MP4 渲染计划。
 *
 * 场景集合与顺序逐条映射为片段；`identity.planDigest` 给定时必须与传入场景的计划摘要一致，
 * 否则说明「要渲染的已经不是这一版课件」，直接拒绝而不是渲染一份对不上账的视频。
 */
export const buildMp4RenderPlan = (input: BuildMp4RenderPlanInput): Mp4RenderPlan => {
  assertValidEncoding(input.encoding);
  if (input.scenes.length === 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_plan_has_no_scenes' });
  }
  const pacing = { ...DEFAULT_PACING, ...(input.pacing ?? {}) };
  if (input.identity.planDigest !== null) {
    const computed = scenePlanDigest({
      lessonId: input.identity.lessonId,
      lessonVersion: input.identity.lessonVersion,
      bundleId: input.identity.bundleId,
      scenes: input.scenes,
    });
    if (computed !== input.identity.planDigest) {
      throw new StudyError('VERSION_CONFLICT', {
        reason: 'mp4_plan_digest_mismatch',
        expected: input.identity.planDigest,
        actual: computed,
      });
    }
  }
  const runtimes = normalizeMp4Runtimes(input.runtimes);

  let cursor = 0;
  const segments = input.scenes.map((scene, index) => {
    const durationMs = estimateSegmentMs(sceneReadableText(scene), pacing);
    const segment: Mp4Segment = {
      index,
      sceneId: scene.sceneId,
      sceneKind: scene.kind,
      title: scene.title,
      startMs: cursor,
      durationMs,
      sceneDigest: planSceneDigest(scene),
    };
    cursor += durationMs;
    return segment;
  });

  const safeLessonId =
    input.identity.lessonId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60) || 'lesson';
  const directory = `exports/${safeLessonId}-v${input.identity.lessonVersion}`;
  const planWithoutDigest: Omit<Mp4RenderPlan, 'digest'> = {
    planVersion: MP4_EXPORT_VERSION,
    format: 'mp4',
    generatedAt: input.generatedAt ?? '',
    identity: input.identity,
    encoding: input.encoding,
    canvas: input.canvas,
    segments,
    totalDurationMs: cursor,
    runtimes,
    output: { directory, fileName: `lesson-${safeLessonId}-v${input.identity.lessonVersion}.mp4` },
  };

  return { ...planWithoutDigest, digest: mp4RenderPlanDigest(planWithoutDigest) };
};

// ————————————————————————— 任务状态机 —————————————————————————

const TERMINAL_STATES: ReadonlySet<Mp4JobState> = new Set<Mp4JobState>(['succeeded', 'cancelled']);

const TRANSITIONS: Readonly<Record<Mp4JobEvent, readonly Mp4JobState[]>> = {
  enqueue: ['draft'],
  'begin-preparation': ['queued', 'blocked'],
  'resources-verified': ['preparing'],
  'resources-unavailable': ['preparing'],
  'begin-capture': ['preparing'],
  'segment-captured': ['capturing'],
  'capture-completed': ['capturing'],
  'begin-encoding': ['capturing'],
  'encoding-completed': ['encoding'],
  fail: ['queued', 'preparing', 'blocked', 'capturing', 'encoding'],
  cancel: ['queued', 'preparing', 'blocked', 'capturing', 'encoding'],
  requeue: ['failed'],
};

/** 当前状态下允许的事件（界面据此禁用按钮，而不是点了再报错）。 */
export const mp4JobAllowedEvents = (job: Mp4RenderJob): Mp4JobEvent[] =>
  MP4_JOB_EVENTS.filter((event) => TRANSITIONS[event].includes(job.state));

const pushEvent = (
  job: Mp4RenderJob,
  event: Mp4JobEvent,
  state: Mp4JobState,
  at: string,
  note: string,
): Mp4RenderJob => ({
  ...job,
  state,
  updatedAt: at,
  events: [...job.events, { state, event, at, note }],
});

/** 新任务：`draft` 起步，必须先 `enqueue`；幂等号由调用方（请求 `requestId`）给出。 */
export const createMp4RenderJob = (input: {
  readonly jobId: string;
  readonly requestId: string;
  readonly plan: Mp4RenderPlan;
  readonly maxAttempts?: number;
  readonly at: string;
}): Mp4RenderJob => {
  const attempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_max_attempts_invalid' });
  }
  const job: Mp4RenderJob = {
    jobId: input.jobId,
    state: 'draft',
    planDigest: input.plan.digest,
    requestedAt: input.at,
    updatedAt: input.at,
    requestId: input.requestId,
    attempts: 0,
    maxAttempts: attempts,
    nextSegmentIndex: 0,
    completedSegments: [],
    failure: null,
    delivery: { status: 'none', fileName: null, byteLength: null, sha256: null, playable: false },
    events: [],
  };
  return pushEvent(
    job,
    'enqueue',
    'queued',
    input.at,
    `已排队 ${input.plan.segments.length} 个片段`,
  );
};

/**
 * 唯一的推进入口：非法推进即拒绝，状态迁移写入事件轨迹。
 *
 * 关键的守卫（都在这一处收口，界面与执行侧无法各自绕开）：
 * - `resources-verified` 只在运行时确实到位时接受（由调用方以 `mp4BlockingRuntimes` 判定后传入）；
 *   宣称就绪却带缺口 → 拒绝，任务停在 `preparing`；带缺口则走 `resources-unavailable` 进 `blocked`；
 * - 未通过运行时核验的任务根本进不到 `begin-capture`（该事件只接受 `preparing` 状态）；
 * - `segment-captured` 必须按**连续顺序**推进（片段号 == nextSegmentIndex）且带字节数与 sha256；
 * - `encoding-completed` 必须带可播放产物的摘要：`playable` 为 false 时只能算 `fail`，
 *   不能宣称导出成功（清单验收「真实可播放视频」）；
 * - `fail` 必须给出分类；`requeue` 只在 `attempts < maxAttempts` 且失败可恢复时允许。
 */
export const applyMp4JobEvent = (
  job: Mp4RenderJob,
  event: Mp4JobEvent,
  payload: {
    readonly at: string;
    readonly blockingRuntimes?: readonly Mp4RuntimeDeclaration[];
    readonly segmentIndex?: number;
    readonly artifact?: { readonly byteLength: number; readonly sha256: string };
    readonly failure?: Mp4JobFailure;
    readonly output?: {
      readonly fileName: string;
      readonly byteLength: number;
      readonly sha256: string;
      readonly playable: boolean;
    };
    readonly note?: string;
  },
  plan: Mp4RenderPlan,
): Mp4RenderJob => {
  if (!TRANSITIONS[event].includes(job.state)) {
    throw new StudyError('STEP_ALREADY_COMMITTED', {
      reason: 'mp4_illegal_transition',
      state: job.state,
      event,
      allowed: mp4JobAllowedEvents(job),
    });
  }
  if (TERMINAL_STATES.has(job.state)) {
    throw new StudyError('RUN_TERMINATED', { reason: 'mp4_job_terminal', state: job.state });
  }

  switch (event) {
    case 'enqueue':
      return pushEvent(
        job,
        event,
        'queued',
        payload.at,
        payload.note || `已排队 ${plan.segments.length} 个片段`,
      );

    case 'begin-preparation':
      return pushEvent(job, event, 'preparing', payload.at, '开始核验渲染运行时');

    case 'resources-verified': {
      const blocking = payload.blockingRuntimes ?? [];
      if (blocking.length > 0) {
        throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', {
          reason: 'mp4_runtime_unverified',
          references: blocking.map((runtime) => runtime.reference),
        });
      }
      return pushEvent(job, event, 'preparing', payload.at, '运行时核验通过');
    }

    case 'resources-unavailable': {
      const blocking = payload.blockingRuntimes ?? [];
      if (blocking.length === 0) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_blocked_without_gaps' });
      }
      const failure: Mp4JobFailure = {
        class: blocking.some((runtime) => runtime.status === 'mismatched')
          ? 'runtime-mismatch'
          : 'runtime-missing',
        message: `缺少到位的必需渲染运行时：${blocking
          .map((runtime) => `${runtime.reference}（${runtime.note || runtime.status}）`)
          .join('、')}`,
        occurredAt: payload.at,
        segmentIndex: null,
      };
      return pushEvent({ ...job, failure }, event, 'blocked', payload.at, failure.message);
    }

    case 'begin-capture': {
      return pushEvent({ ...job, failure: null }, event, 'capturing', payload.at, '开始逐帧采集');
    }

    case 'segment-captured': {
      const index = payload.segmentIndex;
      const artifact = payload.artifact;
      if (index === undefined || !artifact) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_segment_payload_missing' });
      }
      if (index !== job.nextSegmentIndex) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'mp4_segment_out_of_order',
          expected: job.nextSegmentIndex,
          received: index,
        });
      }
      if (
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isInteger(artifact.byteLength) ||
        artifact.byteLength <= 0
      ) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_segment_artifact_unverified' });
      }
      const segment = plan.segments[index];
      if (!segment) {
        throw new StudyError('NOT_FOUND', { reason: 'mp4_segment_not_in_plan', index });
      }
      return pushEvent(
        {
          ...job,
          completedSegments: [
            ...job.completedSegments,
            { index, byteLength: artifact.byteLength, sha256: artifact.sha256 },
          ],
          nextSegmentIndex: index + 1,
          delivery: { ...job.delivery, status: 'partial' },
        },
        event,
        'capturing',
        payload.at,
        `片段 ${index + 1}/${plan.segments.length} 已采集`,
      );
    }

    case 'capture-completed': {
      if (job.nextSegmentIndex < plan.segments.length) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'mp4_capture_incomplete',
          completed: job.completedSegments.length,
          total: plan.segments.length,
        });
      }
      return pushEvent(job, event, 'capturing', payload.at, '全部片段采集完成');
    }

    case 'begin-encoding': {
      if (job.completedSegments.length !== plan.segments.length) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_encode_needs_all_segments' });
      }
      return pushEvent(job, event, 'encoding', payload.at, 'FFmpeg 编码封装中');
    }

    case 'encoding-completed': {
      const output = payload.output;
      if (
        !output ||
        !/^[a-f0-9]{64}$/.test(output.sha256) ||
        !Number.isInteger(output.byteLength) ||
        output.byteLength <= 0
      ) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_output_evidence_missing' });
      }
      if (!output.playable) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_output_not_playable' });
      }
      if (classifyMediaReference(output.fileName) !== 'package-relative') {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'mp4_output_path_not_portable',
          fileName: output.fileName,
        });
      }
      return pushEvent(
        {
          ...job,
          failure: null,
          delivery: {
            status: 'delivered',
            fileName: output.fileName,
            byteLength: output.byteLength,
            sha256: output.sha256,
            playable: true,
          },
        },
        event,
        'succeeded',
        payload.at,
        `已产出可播放 MP4（${output.byteLength} 字节）`,
      );
    }

    case 'fail': {
      const failure = payload.failure;
      if (!failure || !MP4_FAILURE_CLASSES.includes(failure.class)) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_failure_class_missing' });
      }
      return pushEvent(
        { ...job, failure },
        event,
        'failed',
        payload.at,
        `${failure.class}：${failure.message}`,
      );
    }

    case 'cancel':
      return pushEvent(
        {
          ...job,
          delivery: {
            ...job.delivery,
            status: job.completedSegments.length > 0 ? 'partial' : 'none',
          },
        },
        event,
        'cancelled',
        payload.at,
        payload.note || '任务已取消，半成品不作为导出产物发布',
      );

    case 'requeue': {
      if (job.attempts >= job.maxAttempts) {
        throw new StudyError('BUDGET_EXCEEDED', {
          reason: 'mp4_attempts_exhausted',
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
        });
      }
      if (job.failure && !mp4FailureIsResumable(job.failure.class)) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'mp4_failure_not_resumable',
          class: job.failure.class,
          disposition: MP4_FAILURE_DISPOSITION[job.failure.class],
        });
      }
      return pushEvent(
        { ...job, attempts: job.attempts + 1, failure: null },
        event,
        'queued',
        payload.at,
        `第 ${job.attempts + 1} 次重试（从片段 ${job.nextSegmentIndex + 1} 续跑）`,
      );
    }
  }
};

/** 该失败是否允许保留已完成片段继续跑（digest 类失败必须作废片段）。 */
export const mp4FailureIsResumable = (failure: Mp4FailureClass): boolean => {
  const disposition = MP4_FAILURE_DISPOSITION[failure];
  return disposition === 'recoverable';
};

/** 已完成片段的可信性：只有「计划未漂移 + 片段摘要已复验」的片段才可复用。 */
export const mp4TrustedSegments = (
  job: Mp4RenderJob,
  plan: Mp4RenderPlan,
  facts: { readonly actualSegmentDigests: ReadonlyMap<number, string> },
): Mp4SegmentArtifact[] => {
  const byIndex = new Map(plan.segments.map((segment) => [segment.index, segment]));
  const trusted: Mp4SegmentArtifact[] = [];
  for (const artifact of job.completedSegments) {
    const segment = byIndex.get(artifact.index);
    if (!segment) break;
    if (!Number.isInteger(artifact.byteLength) || artifact.byteLength <= 0) break;
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) break;
    // 磁盘上的实际字节摘要与任务记录不一致 → 从这片开始作废。
    if (facts.actualSegmentDigests.get(artifact.index) !== artifact.sha256) break;
    trusted.push(artifact);
  }
  return trusted;
};

export interface Mp4RecoveryFacts {
  readonly job: Mp4RenderJob;
  readonly plan: Mp4RenderPlan;
  readonly runtimes: readonly Mp4RuntimeDeclaration[];
  /** 磁盘上片段产物的实际摘要（index → sha256）；由执行侧复验后交回。 */
  readonly actualSegmentDigests: ReadonlyMap<number, string>;
  /** 输出文件是否已在磁盘上（及其摘要），用于「结果未知」时的对账。 */
  readonly outputOnDisk: {
    readonly exists: boolean;
    readonly sha256: string | null;
    readonly byteLength: number | null;
  };
  /**
   * 重启后**当前权威**的场景计划内容摘要：由服务侧对本版本现存场景调用 `mp4PlanDigestOf` 得到。
   * 与「任务所依据计划的场景摘要」（`plan.identity.planDigest`）不一致即说明课件内容已变，旧片段整体作废。
   */
  readonly currentPlanDigest: string | null;
  readonly at: string;
}

export interface Mp4RecoveryDecision {
  readonly action: Mp4RecoveryAction;
  readonly fromSegmentIndex: number;
  readonly reason: string;
  readonly discardSegments: number;
  readonly state: Mp4JobState;
}

/**
 * 失败/中断后的判定（acceptance「真实可播放视频与失败恢复」的实现处）。
 *
 * 判定链，自上而下短路：
 * 1. 计划摘要已变（`currentPlanDigest` 与任务的 `planDigest` 不符）→ `replan`：旧片段整体作废；
 * 2. `succeeded` 且产物摘要与磁盘一致 → `none`（幂等重发读回既有结果，不重渲）；
 * 3. 结果未知（任务在 `encoding`/`capturing` 里丢失）但磁盘已有完整输出且摘要可信 → `publish-verified-output`；
 * 4. 必需运行时不到位 → `needs-attention`（回 `blocked`，缺口逐条可见）；
 * 5. 片段字节摘要与记录不符 → 从第一个不符片段作废；剩余片段仍可信 → `resume-from-segment`；
 * 6. 失败分类可恢复且还有重试次数 → `requeue`；次数用尽或分类要求人工 → `needs-attention`。
 */
export const recoverMp4Job = (facts: Mp4RecoveryFacts): Mp4RecoveryDecision => {
  const { job, plan } = facts;
  // 漂移判定比的是「场景计划内容摘要」：任务的 `planDigest` 是渲染计划摘要（含编码参数），
  // 两者不同口径；课件内容是否变了必须对照 `plan.identity.planDigest`。
  const baseline = plan.identity.planDigest;
  const drift =
    facts.currentPlanDigest !== null && baseline !== null && facts.currentPlanDigest !== baseline;
  if (drift) {
    return {
      action: 'replan',
      fromSegmentIndex: 0,
      reason: '课件计划内容已变，旧渲染片段不可复用，需按新计划重新导出',
      discardSegments: job.completedSegments.length,
      state: 'draft',
    };
  }
  if (job.state === 'succeeded') {
    const matched =
      job.delivery.sha256 === facts.outputOnDisk.sha256 &&
      job.delivery.byteLength === facts.outputOnDisk.byteLength;
    return matched
      ? {
          action: 'none',
          fromSegmentIndex: job.nextSegmentIndex,
          reason: '产物已存在且摘要相符',
          discardSegments: 0,
          state: 'succeeded',
        }
      : {
          action: 'replan',
          fromSegmentIndex: 0,
          reason: '任务宣称成功但磁盘产物与记录不符，已按未完成处理',
          discardSegments: plan.segments.length,
          state: 'draft',
        };
  }
  if (job.state === 'cancelled') {
    return {
      action: 'none',
      fromSegmentIndex: job.nextSegmentIndex,
      reason: '任务已取消，不自动续跑',
      discardSegments: job.completedSegments.length,
      state: 'cancelled',
    };
  }

  const gaps = mp4BlockingRuntimes(facts.runtimes);
  if (gaps.length > 0) {
    return {
      action: 'needs-attention',
      fromSegmentIndex: job.nextSegmentIndex,
      reason: `渲染运行时未到位：${gaps.map((runtime) => `${runtime.reference}(${runtime.status})`).join('、')}`,
      discardSegments: 0,
      state: 'blocked',
    };
  }

  // 「结果未知」：进程被杀/响应丢失，但输出可能已经写好。先对账再决定，绝不盲目重跑一遍。
  if (facts.outputOnDisk.exists && facts.outputOnDisk.sha256 !== null && job.state === 'encoding') {
    return {
      action: 'publish-verified-output',
      fromSegmentIndex: job.nextSegmentIndex,
      reason: '编码结果已在磁盘上且带摘要，按已完成产物发布而不重渲',
      discardSegments: 0,
      state: 'encoding',
    };
  }

  const trusted = mp4TrustedSegments(job, plan, {
    actualSegmentDigests: facts.actualSegmentDigests,
  });
  const discarded = job.completedSegments.length - trusted.length;
  const fromSegmentIndex = trusted.length;
  if (discarded > 0) {
    return {
      action: 'resume-from-segment',
      fromSegmentIndex,
      reason: `${discarded} 个片段的磁盘字节与记录摘要不符，已从片段 ${fromSegmentIndex + 1} 作废重渲`,
      discardSegments: discarded,
      state: 'queued',
    };
  }
  if (!job.failure && job.state !== 'failed') {
    // 没有失败记录的中断（例如进程被杀、任务丢失）：按结果未知处理，先复验再续跑。
    return {
      action: fromSegmentIndex > 0 ? 'resume-from-segment' : 'reconcile',
      fromSegmentIndex: Math.max(job.nextSegmentIndex, fromSegmentIndex),
      reason:
        fromSegmentIndex > 0
          ? `任务中断且无失败记录，从片段 ${job.nextSegmentIndex + 1} 继续`
          : '任务中断且尚无可信片段，需先复验磁盘现场',
      discardSegments: 0,
      state: 'queued',
    };
  }
  if (job.failure && mp4FailureIsResumable(job.failure.class)) {
    const resumable = job.attempts < job.maxAttempts;
    return resumable
      ? {
          action: fromSegmentIndex < plan.segments.length ? 'resume-from-segment' : 'requeue',
          fromSegmentIndex,
          reason: `失败分类 ${job.failure.class} 可恢复，保留 ${fromSegmentIndex} 个已校验片段`,
          discardSegments: 0,
          state: 'queued',
        }
      : {
          action: 'needs-attention',
          fromSegmentIndex,
          reason: `重试次数已用尽（${job.attempts}/${job.maxAttempts}），需人工处置：${job.failure.message}`,
          discardSegments: 0,
          state: 'failed',
        };
  }
  if (job.failure && MP4_FAILURE_DISPOSITION[job.failure.class] === 'requires-replan') {
    return {
      action: 'replan',
      fromSegmentIndex: 0,
      reason: `失败分类 ${job.failure.class}：已完成片段整体不可信`,
      discardSegments: job.completedSegments.length,
      state: 'draft',
    };
  }
  return {
    action: 'needs-attention',
    fromSegmentIndex: job.nextSegmentIndex,
    reason: job.failure
      ? `失败分类 ${job.failure.class} 需人工处置：${job.failure.message}`
      : '任务状态需人工核对',
    discardSegments: 0,
    state: 'failed',
  };
};

/** 进度：按已校验片段占比，产物未交付前不会报 100%。 */
export const mp4JobProgress = (job: Mp4RenderJob, plan: Mp4RenderPlan): number => {
  const total = plan.segments.length;
  if (total === 0) return 0;
  const rendered = Math.min(job.completedSegments.length, total) / total;
  if (job.state === 'succeeded') return 1;
  if (job.state === 'encoding') return Math.min(0.95, 0.5 + rendered * 0.4);
  if (job.state === 'capturing') return Math.round(rendered * 0.5 * 1000) / 1000;
  return Math.round(rendered * 0.2 * 1000) / 1000;
};

/** 结果视图：只有 `delivered` 才给出可用产物；其余状态如实报告缺口。 */
export interface Mp4JobResultView {
  readonly delivered: boolean;
  readonly fileName: string | null;
  readonly destination: string | null;
  readonly byteLength: number | null;
  readonly sha256: string | null;
  readonly message: string;
}

export const mp4JobResultView = (job: Mp4RenderJob, plan: Mp4RenderPlan): Mp4JobResultView => {
  if (job.state === 'succeeded' && job.delivery.status === 'delivered' && job.delivery.playable) {
    return {
      delivered: true,
      fileName: job.delivery.fileName,
      destination: `${plan.output.directory}/${job.delivery.fileName}`,
      byteLength: job.delivery.byteLength,
      sha256: job.delivery.sha256,
      message: `已导出 ${plan.segments.length} 个片段、${(plan.totalDurationMs / 1000).toFixed(1)} 秒的可播放 MP4。`,
    };
  }
  const reason = job.failure
    ? job.failure.message
    : mp4BlockingRuntimes(plan.runtimes)
        .map((runtime) => runtime.note)
        .join('；');
  return {
    delivered: false,
    fileName: null,
    destination: null,
    byteLength: null,
    sha256: null,
    message:
      reason ||
      `渲染未完成（状态 ${job.state}，已完成 ${job.completedSegments.length}/${plan.segments.length} 个片段）。`,
  };
};

/** 时长上界（避免异常估算被当成真实产物）：给界面显示「约多久」。 */
export const mp4PlanDurationUpperBoundMs = (plan: Mp4RenderPlan): number =>
  plan.segments.reduce(
    (total, segment) => Math.min(total + segment.durationMs, 4 * 60 * 60 * 1000),
    0,
  );

/** 计划里的片段是否逐条覆盖场景（恢复时先做一次自洽核对）。 */
export const mp4PlanMatchesScenes = (
  plan: Mp4RenderPlan,
  scenes: readonly PlanSceneDto[],
): boolean => {
  if (plan.segments.length !== scenes.length) return false;
  return plan.segments.every(
    (segment, index) =>
      segment.index === index &&
      segment.sceneId === scenes[index]!.sceneId &&
      segment.sceneDigest === planSceneDigest(scenes[index]!),
  );
};

/** 从既有计划 DTO 取摘要（接入侧构造 identity 时使用，避免两处各算一遍）。 */
export const mp4PlanDigestOf = (
  plan: Pick<ScenePlanDto, 'lessonId' | 'lessonVersion' | 'bundleId' | 'scenes'>,
): string => scenePlanDigest(plan);
