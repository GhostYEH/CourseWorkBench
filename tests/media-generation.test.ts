import { describe, expect, it } from 'vitest';
import { StudyError } from '../packages/study-contracts/src/errors';
import {
  mediaGenerationCommandSchema,
  mediaProductRefSchema,
  imageGenerationCommandSchema,
  ttsGenerationCommandSchema,
  zeroMediaUsage,
  type MediaProductRefDto,
  type MediaTaskUsageDto,
} from '../packages/study-contracts/src/media-generation';
import {
  assertMediaGenerationAdmitted,
  assertMediaProductCandidate,
  cancelMediaTask,
  mediaPollDecision,
  mediaResumePolicy,
  mediaTaskOutcome,
  settleMediaTask,
} from '../packages/study-domain/src/media-generation';
import type { MediaUsageObservationDto } from '../packages/study-contracts/src/media-generation';

/**
 * 媒体生成合同与任务状态机（OMA-060…064 的验收门槛）。
 *
 * 全部为合同与纯逻辑验证：不发任何真实请求，不生成任何真实图片/视频/语音。
 * 固定四件事：
 * 1. 命令 strict + 有界：多余字段、越界参数、自报权威一律拒绝；
 * 2. started → completed / failed，终态不可再动（断线重放不能二次结算）；
 * 3. completed 必须有真实落盘产物；failed / 取消一律不收产物——失败不伪造产物；
 * 4. 缺 provider / 断网在派发前明确失败；取消优先于超时。
 */

const expectCode = (action: () => unknown, code: string, reason?: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    if (reason !== undefined) expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

const baseScope = { projectId: 'proj-media', generation: 1, runId: 'run-1' };

const imageCommand = (overrides: Record<string, unknown> = {}) => ({
  kind: 'image' as const,
  scope: baseScope,
  requestId: 'req-img-1',
  provider: 'comfyui-local',
  prompt: '函数 y=x² 的图像，坐标轴清晰',
  workflowId: 'wf_sdxl_1',
  workflowLocation: 'local' as const,
  width: 1024,
  height: 1024,
  steps: 25,
  guidance: 7,
  count: 1,
  ...overrides,
});

const videoCommand = (overrides: Record<string, unknown> = {}) => ({
  kind: 'video' as const,
  scope: baseScope,
  requestId: 'req-vid-1',
  provider: 'video-cloud',
  prompt: '抛体运动分解演示',
  durationSeconds: 8,
  poll: { intervalMs: 5_000, maxPolls: 120, deadlineMs: 600_000 },
  ...overrides,
});

const ttsCommand = (overrides: Record<string, unknown> = {}) => ({
  kind: 'tts' as const,
  scope: baseScope,
  requestId: 'req-tts-1',
  provider: 'tts-cloud',
  text: '第二步，把初速度沿水平与竖直方向分解。',
  voiceId: 'voice_teacher_1',
  ...overrides,
});

const asrCommand = (overrides: Record<string, unknown> = {}) => ({
  kind: 'asr' as const,
  scope: baseScope,
  requestId: 'req-asr-1',
  provider: 'funasr-local',
  engine: 'remote' as const,
  microphoneGranted: true,
  audioSeconds: 6.5,
  ...overrides,
});

/** 产物原始形状：允许故意构造非法变体，交给 safeParse 判。 */
const product = (overrides: Record<string, unknown> = {}) => ({
  taskId: 'task-img-1',
  assetId: 'asset_img_1',
  kind: 'image',
  sha256: 'a'.repeat(64),
  byteLength: 102_400,
  mime: 'image/png',
  relativePath: 'media/task-img-1.png',
  reviewStatus: 'pending_review',
  authority: false,
  recordedAt: '2026-10-07T02:00:00.000Z',
  ...overrides,
});

/** 通过合同校验的产物引用，供领域层入口使用。 */
const validProduct = (overrides: Record<string, unknown> = {}): MediaProductRefDto =>
  mediaProductRefSchema.parse(product(overrides));

const usage = (overrides: Record<string, unknown> = {}): MediaTaskUsageDto => ({
  tokens: { promptTokens: 40, completionTokens: null, totalTokens: 40 },
  images: 1,
  videoSeconds: null,
  characters: null,
  audioSeconds: null,
  asrSeconds: null,
  ...overrides,
});

const startedObservation = (
  overrides: Partial<MediaUsageObservationDto> = {},
): MediaUsageObservationDto => ({
  projectId: 'proj-media',
  requestId: 'req-img-1',
  runId: 'run-1',
  taskId: 'task-img-1',
  kind: 'image',
  state: 'started',
  failureKind: null,
  dispatched: true,
  usageMeasurement: 'unknown',
  accounted: null,
  reserved: usage({ images: 1 }),
  elapsedMs: null,
  cost: null,
  costMeasurement: 'unknown',
  createdAt: '2026-10-07T01:00:00.000Z',
  updatedAt: '2026-10-07T01:00:00.000Z',
  ...overrides,
});

describe('媒体生成合同：strict 与有界', () => {
  it('四类命令按 kind 精确分派，公共形状合法即通过', () => {
    expect(mediaGenerationCommandSchema.safeParse(imageCommand()).success).toBe(true);
    expect(mediaGenerationCommandSchema.safeParse(videoCommand()).success).toBe(true);
    expect(mediaGenerationCommandSchema.safeParse(ttsCommand()).success).toBe(true);
    expect(mediaGenerationCommandSchema.safeParse(asrCommand()).success).toBe(true);
    expect(imageGenerationCommandSchema.safeParse(imageCommand()).success).toBe(true);
  });

  it('多余字段与错维度参数被 strict 拒绝，不用别的类型的字段凑数', () => {
    expect(
      mediaGenerationCommandSchema.safeParse(imageCommand({ durationSeconds: 8 })).success,
    ).toBe(false);
    expect(mediaGenerationCommandSchema.safeParse(videoCommand({ steps: 20 })).success).toBe(false);
    expect(
      mediaGenerationCommandSchema.safeParse({ ...imageCommand(), apiKey: 'sk-secret' }).success,
    ).toBe(false);
    expect(mediaGenerationCommandSchema.safeParse(imageCommand({ kind: undefined })).success).toBe(
      false,
    );
  });

  it('参数长度与数量设上限，超限直接拒绝而不是截断放行', () => {
    expect(
      mediaGenerationCommandSchema.safeParse(imageCommand({ prompt: 'x'.repeat(8_001) })).success,
    ).toBe(false);
    expect(mediaGenerationCommandSchema.safeParse(imageCommand({ count: 99 })).success).toBe(false);
    expect(
      mediaGenerationCommandSchema.safeParse(ttsCommand({ text: 'x'.repeat(20_001) })).success,
    ).toBe(false);
    expect(
      mediaGenerationCommandSchema.safeParse(
        videoCommand({ poll: { intervalMs: 5_000, maxPolls: 2_001, deadlineMs: 600_000 } }),
      ).success,
    ).toBe(false);
    expect(
      mediaGenerationCommandSchema.safeParse(
        videoCommand({ poll: { intervalMs: 600_001, maxPolls: 10, deadlineMs: 600_000 } }),
      ).success,
    ).toBe(false);
  });

  it('播放速度限定在 0.5–2，倍率不能越界（OMA-062）', () => {
    expect(ttsGenerationCommandSchema.safeParse(ttsCommand({ playbackRate: 0.25 })).success).toBe(
      false,
    );
    expect(ttsGenerationCommandSchema.safeParse(ttsCommand({ playbackRate: 3 })).success).toBe(
      false,
    );
    const parsed = ttsGenerationCommandSchema.safeParse(ttsCommand());
    expect(parsed.success ? parsed.data.playbackRate : null).toBe(1);
  });

  it('麦克风授权必须显式给出，服务端不推断（OMA-064）', () => {
    expect(
      mediaGenerationCommandSchema.safeParse(asrCommand({ microphoneGranted: undefined })).success,
    ).toBe(false);
    expect(
      mediaGenerationCommandSchema.safeParse(asrCommand({ microphoneGranted: 'yes' })).success,
    ).toBe(false);
  });
});

describe('产物候选纪律：只进待核区，不进权威', () => {
  it('合法产物引用通过；自报权威、外部 URL、越界路径一律拒绝', () => {
    expect(mediaProductRefSchema.safeParse(product()).success).toBe(true);
    // `authority` 是字面量 false：合同层面就没有「权威产物」这个取值。
    expect(mediaProductRefSchema.safeParse(product({ authority: true })).success).toBe(false);
    expect(mediaProductRefSchema.safeParse(product({ reviewStatus: 'approved' })).success).toBe(
      false,
    );
    expect(
      mediaProductRefSchema.safeParse(product({ relativePath: 'https://cdn.example.com/a.png' }))
        .success,
    ).toBe(false);
    expect(
      mediaProductRefSchema.safeParse(product({ relativePath: '../../outside.png' })).success,
    ).toBe(false);
    expect(
      mediaProductRefSchema.safeParse(product({ relativePath: 'C:\\media\\a.png' })).success,
    ).toBe(false);
    expect(mediaProductRefSchema.safeParse(product({ sha256: 'not-a-digest' })).success).toBe(
      false,
    );
    expect(mediaProductRefSchema.safeParse(product({ extra: 1 })).success).toBe(false);
  });

  it('绕过合同手工构造的「权威产物」在领域层再判一次并被拒绝', () => {
    // 双步断言绕过字面量类型——模拟数据库外的手工对象或旧版本残留记录。
    const forged = {
      ...product(),
      authority: true,
      reviewStatus: 'approved',
    } as unknown as MediaProductRefDto;
    expectCode(
      () => assertMediaProductCandidate(forged),
      'VERSION_CONFLICT',
      'media_product_not_candidate',
    );
    expect(mediaProductRefSchema.safeParse({ ...product(), authority: true }).success).toBe(false);
    expect(() => assertMediaProductCandidate(validProduct())).not.toThrow();
  });
});

describe('缺 provider / 断网：派发前明确失败', () => {
  const admitted = { providerConfigured: true, networkAvailable: true, runTerminated: false };

  it('provider 未配置与断网是两种不同失败，都在请求发出之前拒绝', () => {
    expectCode(
      () =>
        assertMediaGenerationAdmitted({
          command: mediaGenerationCommandSchema.parse(videoCommand()),
          ...admitted,
          providerConfigured: false,
        }),
      'MODEL_NOT_CONFIGURED',
      'media_provider_not_configured',
    );
    // 「连接状态未知」按断网处理：不确定就是不能发。
    expectCode(
      () =>
        assertMediaGenerationAdmitted({
          command: mediaGenerationCommandSchema.parse(videoCommand()),
          ...admitted,
          networkAvailable: null,
        }),
      'MODEL_NOT_CONFIGURED',
      'media_no_connection',
    );
    expectCode(
      () =>
        assertMediaGenerationAdmitted({
          command: mediaGenerationCommandSchema.parse(videoCommand()),
          ...admitted,
          runTerminated: true,
        }),
      'RUN_TERMINATED',
      'media_run_terminated',
    );
  });

  it('本机 ComfyUI 与本地 ASR 允许离线，但本地 ASR 必须先拿到录音授权', () => {
    expect(() =>
      assertMediaGenerationAdmitted({
        command: mediaGenerationCommandSchema.parse(imageCommand()),
        ...admitted,
        providerConfigured: false,
        networkAvailable: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertMediaGenerationAdmitted({
        command: mediaGenerationCommandSchema.parse(
          asrCommand({ engine: 'local_funasr', provider: 'funasr-local' }),
        ),
        ...admitted,
        providerConfigured: false,
        networkAvailable: false,
      }),
    ).not.toThrow();
    expectCode(
      () =>
        assertMediaGenerationAdmitted({
          command: mediaGenerationCommandSchema.parse(
            asrCommand({ engine: 'local_funasr', microphoneGranted: false }),
          ),
          ...admitted,
          providerConfigured: false,
          networkAvailable: false,
        }),
      'ROLE_PERMISSION_DENIED',
      'media_microphone_not_granted',
    );
  });
});

describe('任务状态机：started → completed / failed，失败不伪造产物', () => {
  it('completed 必须带至少一个产物；provider 给了计数就按实际入账', () => {
    const settled = settleMediaTask({
      observation: startedObservation(),
      next: 'completed',
      products: [validProduct()],
      providerUsage: usage({ images: 1 }),
      estimatedUsage: null,
      priceKnown: false,
      cost: null,
      costIsEstimate: false,
      elapsedMs: 30_000,
      nowIso: '2026-10-07T01:00:30.000Z',
    });
    expect(settled.state).toBe('completed');
    expect(settled.failureKind).toBeNull();
    expect(settled.usageMeasurement).toBe('actual');
    expect(settled.accounted).not.toBeNull();
  });

  it('provider 没给计数但有可复核估算 → 记估算；两者皆无 → 拒收 completed，不替它编数字', () => {
    const estimated = settleMediaTask({
      observation: startedObservation(),
      next: 'completed',
      products: [validProduct()],
      providerUsage: null,
      estimatedUsage: usage({ images: 1 }),
      priceKnown: false,
      cost: null,
      costIsEstimate: false,
      elapsedMs: 10,
      nowIso: '2026-10-07T01:00:01.000Z',
    });
    expect(estimated.usageMeasurement).toBe('estimated');
    expectCode(
      () =>
        settleMediaTask({
          observation: startedObservation(),
          next: 'completed',
          products: [validProduct()],
          providerUsage: null,
          estimatedUsage: null,
          priceKnown: false,
          cost: null,
          costIsEstimate: false,
          elapsedMs: 10,
          nowIso: '2026-10-07T01:00:01.000Z',
        }),
      'INVALID_ARGUMENT',
      'media_usage_evidence_missing',
    );
  });

  it('没有产物的「成功」被拒绝；产物维度与任务不符也被拒绝', () => {
    expectCode(
      () =>
        settleMediaTask({
          observation: startedObservation(),
          next: 'completed',
          products: [],
          providerUsage: usage({ images: 1 }),
          estimatedUsage: null,
          priceKnown: false,
          cost: null,
          costIsEstimate: false,
          elapsedMs: 10,
          nowIso: '2026-10-07T01:00:01.000Z',
        }),
      'INVALID_ARGUMENT',
      'media_products_missing',
    );
    expectCode(
      () =>
        settleMediaTask({
          observation: startedObservation(),
          next: 'completed',
          products: [validProduct({ kind: 'video', durationSeconds: 8 })],
          providerUsage: usage({ images: 1 }),
          estimatedUsage: null,
          priceKnown: false,
          cost: null,
          costIsEstimate: false,
          elapsedMs: 10,
          nowIso: '2026-10-07T01:00:01.000Z',
        }),
      'INVALID_ARGUMENT',
      'media_product_kind_mismatch',
    );
  });

  it('failed 一律不收产物——半成品与「顺手拿回来的文件」都不入账', () => {
    expectCode(
      () =>
        settleMediaTask({
          observation: startedObservation(),
          next: 'failed',
          failureKind: 'provider_error',
          products: [validProduct()],
          providerUsage: null,
          estimatedUsage: null,
          priceKnown: false,
          cost: null,
          costIsEstimate: false,
          elapsedMs: 5,
          nowIso: '2026-10-07T01:00:05.000Z',
        }),
      'INVALID_ARGUMENT',
      'media_failed_task_rejects_products',
    );

    const failed = settleMediaTask({
      observation: startedObservation(),
      next: 'failed',
      failureKind: 'provider_error',
      products: [],
      providerUsage: null,
      estimatedUsage: null,
      priceKnown: false,
      cost: null,
      costIsEstimate: false,
      elapsedMs: 5,
      nowIso: '2026-10-07T01:00:05.000Z',
    });
    expect(failed.state).toBe('failed');
    expect(failed.failureKind).toBe('provider_error');
    // 发出去了但拿不到任何用量依据：保留预占记未知，不按 0 计。
    expect(failed.usageMeasurement).toBe('unknown');
    expect(failed.accounted).toBeNull();
  });

  it('failed 必须给出确定原因；断线无法归因时如实记 unknown_outcome 并显示「结果未知」', () => {
    expectCode(
      () =>
        settleMediaTask({
          observation: startedObservation(),
          next: 'failed',
          failureKind: 'exploded' as never,
          products: [],
          providerUsage: null,
          estimatedUsage: null,
          priceKnown: false,
          cost: null,
          costIsEstimate: false,
          elapsedMs: 1,
          nowIso: '2026-10-07T01:00:01.000Z',
        }),
      'INVALID_ARGUMENT',
      'media_failure_kind_missing',
    );
    const outcome = mediaTaskOutcome(
      startedObservation({
        state: 'failed',
        failureKind: 'unknown_outcome',
      }),
    );
    expect(outcome).toMatchObject({ state: 'failed', showsAsFailed: true, outcomeKnown: false });
  });

  it('终态不可再结算：断线重放不会把一次生成记成两次', () => {
    const done = settleMediaTask({
      observation: startedObservation(),
      next: 'completed',
      products: [validProduct()],
      providerUsage: usage({ images: 1 }),
      estimatedUsage: null,
      priceKnown: false,
      cost: null,
      costIsEstimate: false,
      elapsedMs: 10,
      nowIso: '2026-10-07T01:00:10.000Z',
    });
    expectCode(
      () =>
        settleMediaTask({
          observation: done,
          next: 'completed',
          products: [validProduct()],
          providerUsage: usage({ images: 1 }),
          estimatedUsage: null,
          priceKnown: false,
          cost: null,
          costIsEstimate: false,
          elapsedMs: 10,
          nowIso: '2026-10-07T01:00:20.000Z',
        }),
      'VERSION_CONFLICT',
      'media_task_already_settled',
    );
    expectCode(
      () =>
        settleMediaTask({
          observation: done,
          next: 'failed',
          failureKind: 'cancelled',
          products: [],
          providerUsage: null,
          estimatedUsage: null,
          priceKnown: false,
          cost: null,
          costIsEstimate: false,
          elapsedMs: 1,
          nowIso: '2026-10-07T01:00:21.000Z',
        }),
      'VERSION_CONFLICT',
      'media_task_already_settled',
    );
    expect(mediaResumePolicy({ state: 'started' })).toEqual({
      policy: 'refuse_auto_replay',
      keepReservation: true,
    });
    expect(mediaResumePolicy({ state: 'completed' })).toEqual({
      policy: 'reuse_settled',
      keepReservation: false,
    });
    expect(mediaResumePolicy({ state: 'failed' })).toEqual({
      policy: 'reuse_settled',
      keepReservation: false,
    });
  });
});

describe('视频轮询、取消与超时（OMA-061 真实轮询/取消/超时的判定面）', () => {
  const polling = {
    providerState: 'running' as const,
    productsAvailable: false,
    cancelled: false,
    elapsedMs: 60_000,
    deadlineMs: 600_000,
    intervalMs: 5_000,
    pollsDone: 12,
    maxPolls: 120,
  };

  it('未完成继续等；下一次间隔压进剩余墙钟，最后一个 interval 不会跑过 deadline', () => {
    expect(mediaPollDecision(polling)).toEqual({
      action: 'continue',
      failureKind: null,
      nextPollInMs: 5_000,
    });
    expect(mediaPollDecision({ ...polling, elapsedMs: 598_000 }).nextPollInMs).toBe(2_000);
  });

  it('provider 说成功但产物拿不到 → 按失败处理，不伪造成 completed', () => {
    expect(
      mediaPollDecision({ ...polling, providerState: 'succeeded', productsAvailable: false }),
    ).toEqual({ action: 'failed', failureKind: 'provider_error', nextPollInMs: null });
    expect(
      mediaPollDecision({ ...polling, providerState: 'succeeded', productsAvailable: true }),
    ).toEqual({ action: 'succeeded', failureKind: null, nextPollInMs: null });
  });

  it('取消优先于超时：用户明确表达覆盖系统推断', () => {
    const decided = mediaPollDecision({ ...polling, cancelled: true, elapsedMs: 700_000 });
    expect(decided).toEqual({ action: 'failed', failureKind: 'cancelled', nextPollInMs: null });
  });

  it('超时与查询次数用尽是两种确定原因；轮询事实非法按内部判定错误拒绝', () => {
    expect(mediaPollDecision({ ...polling, elapsedMs: 600_000 }).failureKind).toBe(
      'deadline_exceeded',
    );
    expect(mediaPollDecision({ ...polling, pollsDone: 120, maxPolls: 120 }).failureKind).toBe(
      'poll_limit_exceeded',
    );
    expectCode(
      () => mediaPollDecision({ ...polling, elapsedMs: -1 }),
      'INVALID_ARGUMENT',
      'media_poll_facts_invalid',
    );
  });

  it('取消已派发的任务保留预占；未派发的确知 0；取消不带任何产物', () => {
    const dispatched = cancelMediaTask({
      observation: startedObservation(),
      nowIso: '2026-10-07T01:00:40.000Z',
    });
    expect(dispatched.observation.state).toBe('failed');
    expect(dispatched.observation.failureKind).toBe('cancelled');
    expect(dispatched.keepReservation).toBe(true);
    expect(dispatched.products).toEqual([]);

    const notDispatched = cancelMediaTask({
      observation: startedObservation({ dispatched: false }),
      nowIso: '2026-10-07T01:00:41.000Z',
    });
    expect(notDispatched.keepReservation).toBe(false);
    expect(notDispatched.observation.usageMeasurement).toBe('actual');
    expect(notDispatched.observation.accounted).toEqual(zeroMediaUsage());

    expectCode(
      () =>
        cancelMediaTask({
          observation: startedObservation({ state: 'completed' }),
          nowIso: '2026-10-07T01:00:42.000Z',
        }),
      'VERSION_CONFLICT',
      'media_task_already_settled',
    );
  });
});
