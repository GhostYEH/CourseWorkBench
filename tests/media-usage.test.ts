import { describe, expect, it } from 'vitest';
import { StudyError } from '../packages/study-contracts/src/errors';
import {
  asrGenerationCommandSchema,
  imageGenerationCommandSchema,
  mediaProductRefSchema,
  mediaUsageLedgerSchema,
  ttsGenerationCommandSchema,
  videoGenerationCommandSchema,
  zeroMediaUsage,
  type MediaTaskUsageDto,
  type MediaUsageObservationDto,
} from '../packages/study-contracts/src/media-generation';
import {
  assertMediaBudget,
  mediaConsumptionOf,
  mediaCostMeasurement,
  mediaLedgerForRun,
  mediaReservationOf,
  mediaSettlement,
  mediaTextLedgerEntry,
  settleMediaTask,
  summarizeMediaUsage,
} from '../packages/study-domain/src/media-generation';

/**
 * 多模态用量记录与查看（OMA-065）——重算口径。
 *
 * 与文本台账同一纪律：实际 / 估算 / 未知 / 未结算四档分列，未知绝不按 0 计；
 * 分类账是对观察记录的纯重算，顺序无关，界面显示的每一项都能由原始记录推出来。
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

const use = (overrides: Partial<MediaTaskUsageDto> = {}): MediaTaskUsageDto => ({
  tokens: { promptTokens: null, completionTokens: null, totalTokens: null },
  images: null,
  videoSeconds: null,
  characters: null,
  audioSeconds: null,
  asrSeconds: null,
  ...overrides,
});

const observation = (
  id: string,
  overrides: Partial<MediaUsageObservationDto> = {},
): MediaUsageObservationDto => ({
  projectId: 'proj-media',
  requestId: `req-${id}`,
  runId: 'run-1',
  taskId: `task-${id}`,
  kind: 'image',
  state: 'completed',
  failureKind: null,
  dispatched: true,
  usageMeasurement: 'actual',
  accounted: use({ images: 1 }),
  reserved: use({ images: 1 }),
  elapsedMs: 1_000,
  cost: null,
  costMeasurement: 'unknown',
  createdAt: '2026-10-07T01:00:00.000Z',
  updatedAt: '2026-10-07T01:00:02.000Z',
  ...overrides,
});

describe('媒体用量口径：四档分列，未知不按 0 计', () => {
  it('实际/估算各记各档并释放预占；未结算整笔继续占用', () => {
    expect(
      mediaConsumptionOf(
        observation('a', {
          accounted: use({
            images: 2,
            tokens: { promptTokens: 10, completionTokens: null, totalTokens: 10 },
          }),
          reserved: use({ images: 4 }),
        }),
      ).actual,
    ).toEqual({ tokens: 10, images: 2, seconds: 0, characters: 0 });
    expect(
      mediaConsumptionOf(
        observation('b', {
          usageMeasurement: 'estimated',
          accounted: use({ videoSeconds: 8 }),
          reserved: use({ videoSeconds: 8 }),
        }),
      ).estimated.seconds,
    ).toBe(8);
    // 还在跑：整笔预占进未结算档，实际档保持 0。
    const pending = mediaConsumptionOf(
      observation('c', {
        state: 'started',
        usageMeasurement: 'unknown',
        accounted: null,
        reserved: use({ characters: 120 }),
      }),
    );
    expect(pending.unsettled.characters).toBe(120);
    expect(pending.actual.characters).toBe(0);
    // 派发了但拿不到任何依据：整笔预占记「未知」，不按 0 计。
    const unknown = mediaConsumptionOf(
      observation('d', {
        usageMeasurement: 'unknown',
        accounted: null,
        reserved: use({ images: 3 }),
      }),
    );
    expect(unknown.unknown.images).toBe(3);
    expect(unknown.unsettled.images).toBe(0);
  });

  it('结算口径：未派发确知 0；provider 回包优先估算；两者皆无保留预占', () => {
    expect(
      mediaSettlement({ dispatched: false, providerUsage: null, estimatedUsage: null }),
    ).toEqual({ measurement: 'actual', accounted: zeroMediaUsage(), keepsReservation: false });
    expect(
      mediaSettlement({
        dispatched: true,
        providerUsage: use({ images: 1 }),
        estimatedUsage: use({ images: 9 }),
      }),
    ).toMatchObject({ measurement: 'actual', keepsReservation: false });
    expect(
      mediaSettlement({
        dispatched: true,
        providerUsage: null,
        estimatedUsage: use({ images: 9 }),
      }),
    ).toMatchObject({ measurement: 'estimated', keepsReservation: false });
    expect(
      mediaSettlement({ dispatched: true, providerUsage: null, estimatedUsage: null }),
    ).toEqual({ measurement: 'unknown', accounted: null, keepsReservation: true });
  });

  it('费用没有价格依据时保持未知，不返回 0 元', () => {
    expect(
      mediaCostMeasurement({
        priceKnown: false,
        tokensKnown: true,
        cost: 12,
        costIsEstimate: false,
      }),
    ).toEqual({ cost: null, measurement: 'unknown' });
    expect(
      mediaCostMeasurement({
        priceKnown: true,
        tokensKnown: false,
        cost: 12,
        costIsEstimate: false,
      }),
    ).toEqual({ cost: null, measurement: 'unknown' });
    expect(
      mediaCostMeasurement({
        priceKnown: true,
        tokensKnown: true,
        cost: 12,
        costIsEstimate: false,
      }),
    ).toEqual({ cost: 12, measurement: 'actual' });
    expect(
      mediaCostMeasurement({ priceKnown: true, tokensKnown: true, cost: 12, costIsEstimate: true }),
    ).toEqual({ cost: 12, measurement: 'estimated' });
  });

  it('派发预占按命令上界折算：图像按张、视频与转写按秒、TTS 按字符', () => {
    expect(
      mediaReservationOf(
        imageGenerationCommandSchema.parse({
          kind: 'image',
          scope: { projectId: 'p', generation: 1, runId: 'r' },
          requestId: 'x',
          provider: 'comfyui-local',
          prompt: 'p',
          workflowId: 'w',
          workflowLocation: 'local',
          width: 512,
          height: 512,
          steps: 10,
          guidance: 5,
          count: 3,
        }),
      ),
    ).toEqual({ tokens: 0, images: 3, seconds: 0, characters: 0 });
    expect(
      mediaReservationOf(
        videoGenerationCommandSchema.parse({
          kind: 'video',
          scope: { projectId: 'p', generation: 1, runId: 'r' },
          requestId: 'x',
          provider: 'v',
          prompt: 'p',
          durationSeconds: 12.5,
          poll: { intervalMs: 1_000, maxPolls: 10, deadlineMs: 60_000 },
        }),
      ).seconds,
    ).toBe(12.5);
    expect(
      mediaReservationOf(
        ttsGenerationCommandSchema.parse({
          kind: 'tts',
          scope: { projectId: 'p', generation: 1, runId: 'r' },
          requestId: 'x',
          provider: 't',
          text: '一二三四五',
          voiceId: 'voice-1',
        }),
      ).characters,
    ).toBe(5);
    expect(
      mediaReservationOf(
        asrGenerationCommandSchema.parse({
          kind: 'asr',
          scope: { projectId: 'p', generation: 1, runId: 'r' },
          requestId: 'x',
          provider: 'a',
          engine: 'local_funasr',
          microphoneGranted: true,
          audioSeconds: 7.25,
        }),
      ).seconds,
    ).toBe(7.25);
  });
});

describe('媒体用量分类账：可重算、与顺序无关、账单不完整要说明', () => {
  const rows: MediaUsageObservationDto[] = [
    observation('img', {
      kind: 'image',
      accounted: use({
        images: 2,
        tokens: { promptTokens: 10, completionTokens: null, totalTokens: 15 },
      }),
      reserved: use({ images: 2 }),
    }),
    observation('vid', {
      kind: 'video',
      accounted: use({ videoSeconds: 9 }),
      reserved: use({ videoSeconds: 10 }),
      elapsedMs: 40_000,
    }),
    observation('tts', {
      kind: 'tts',
      usageMeasurement: 'estimated',
      accounted: use({ characters: 120, audioSeconds: 6.5 }),
      reserved: use({ characters: 130 }),
      elapsedMs: 3_000,
    }),
    observation('asr', {
      kind: 'asr',
      state: 'started',
      usageMeasurement: 'unknown',
      accounted: null,
      reserved: use({ asrSeconds: 20 }),
      elapsedMs: null,
    }),
  ];

  it('实际/估算/未知/未结算分别合计，按类型分账，形状通过合同校验', () => {
    const ledger = mediaLedgerForRun('run-1', rows);
    expect(mediaUsageLedgerSchema.safeParse(ledger).success).toBe(true);
    expect(ledger.total.calls).toBe(4);
    expect(ledger.total.actual).toEqual({ tokens: 15, images: 2, seconds: 9, characters: 0 });
    expect(ledger.total.estimated).toEqual({ tokens: 0, images: 0, seconds: 6.5, characters: 120 });
    expect(ledger.total.unsettled).toEqual({ tokens: 0, images: 0, seconds: 20, characters: 0 });
    expect(ledger.total.elapsedMs).toBe(44_000);
    expect(ledger.total.unknownCostCalls).toBe(4);
    expect(ledger.total.actualCost).toBeNull();
    expect(ledger.byKind.map((item) => item.kind)).toEqual(['image', 'video', 'tts', 'asr']);
    expect(ledger.unsettled).toHaveLength(1);
    expect(ledger.unsettled[0]?.taskId).toBe('task-asr');
    // 还有未结算/未知占用 → 账单不完整，界面不能把「实际」当全部花费。
    expect(ledger.hasUnaccounted).toBe(true);
  });

  it('重算与输入顺序无关：分类账是纯函数，不依赖写入次序', () => {
    const reversed = mediaLedgerForRun('run-1', [...rows].reverse());
    const shuffled = mediaLedgerForRun('run-1', [rows[2]!, rows[0]!, rows[3]!, rows[1]!]);
    expect(reversed.total).toEqual(shuffled.total);
    expect(reversed.total).toEqual(mediaLedgerForRun('run-1', rows).total);
    // byKind 按固定类目序输出，不受输入顺序影响。
    expect(reversed.byKind.map((item) => item.kind)).toEqual(['image', 'video', 'tts', 'asr']);
  });

  it('派发了但结果未知的调用继续占额度：未知不会被静默释放', () => {
    const lost = observation('lost', {
      state: 'failed',
      failureKind: 'unknown_outcome',
      usageMeasurement: 'unknown',
      accounted: null,
      reserved: use({ images: 4 }),
    });
    const ledger = mediaLedgerForRun('run-1', [lost]);
    expect(ledger.total.unknown.images).toBe(4);
    expect(ledger.total.actual.images).toBe(0);
    expect(ledger.hasUnaccounted).toBe(true);
    expectCode(
      () =>
        settleMediaTask({
          observation: lost as MediaUsageObservationDto & { state: 'started' },
          next: 'completed',
          products: [
            mediaProductRefSchema.parse({
              taskId: 'task-lost',
              assetId: 'a',
              kind: 'image',
              sha256: 'b'.repeat(64),
              byteLength: 1,
              mime: 'image/png',
              relativePath: 'media/lost.png',
              reviewStatus: 'pending_review',
              authority: false,
              recordedAt: '2026-10-07T01:00:00.000Z',
            }),
          ],
          providerUsage: null,
          estimatedUsage: null,
          priceKnown: false,
          cost: null,
          costIsEstimate: false,
          elapsedMs: 1,
          nowIso: '2026-10-07T01:00:01.000Z',
        }),
      'VERSION_CONFLICT',
      'media_task_already_settled',
    );
  });

  it('结算超出预占被拒：分类账里不容得下凭空多出来的消耗', () => {
    expectCode(
      () =>
        settleMediaTask({
          observation: observation('over', {
            state: 'started',
            usageMeasurement: 'unknown',
            accounted: null,
            reserved: use({ images: 2 }),
          }),
          next: 'completed',
          products: [
            mediaProductRefSchema.parse({
              taskId: 'task-over',
              assetId: 'a2',
              kind: 'image',
              sha256: 'c'.repeat(64),
              byteLength: 1,
              mime: 'image/png',
              relativePath: 'media/over.png',
              reviewStatus: 'pending_review',
              authority: false,
              recordedAt: '2026-10-07T01:00:00.000Z',
            }),
          ],
          providerUsage: use({ images: 3 }),
          estimatedUsage: null,
          priceKnown: false,
          cost: null,
          costIsEstimate: false,
          elapsedMs: 10,
          nowIso: '2026-10-07T01:00:10.000Z',
        }),
      'BUDGET_EXCEEDED',
      'media_usage_exceeds_reservation',
    );
  });
});

describe('派发前媒体预算与文本维度换算', () => {
  it('张数不够在派发前拒绝，而不是先生成再报超额', () => {
    expectCode(
      () =>
        assertMediaBudget({
          limits: { tokens: 10_000, images: 2, seconds: 60, characters: 4_000 },
          used: { tokens: 0, images: 2, seconds: 0, characters: 0 },
          reserved: { tokens: 0, images: 1, seconds: 0, characters: 0 },
        }),
      'BUDGET_EXCEEDED',
      'media_images',
    );
    expectCode(
      () =>
        assertMediaBudget({
          limits: { tokens: 10_000, images: 10, seconds: 30, characters: 4_000 },
          used: { tokens: 0, images: 0, seconds: 25, characters: 0 },
          reserved: { tokens: 0, images: 0, seconds: 8, characters: 0 },
        }),
      'BUDGET_EXCEEDED',
      'media_seconds',
    );
    expect(() =>
      assertMediaBudget({
        limits: { tokens: 10_000, images: 10, seconds: 60, characters: 4_000 },
        used: { tokens: 100, images: 1, seconds: 5, characters: 10 },
        reserved: { tokens: 10, images: 1, seconds: 5, characters: 10 },
      }),
    ).not.toThrow();
  });

  it('提示词的文本额度按既有 token 口径换算进共享台账：provider 优先、估算有依据、无依据保留预占', () => {
    expect(
      mediaTextLedgerEntry({ dispatched: false, promptBytes: 400, providerTokens: null }),
    ).toMatchObject({ measurement: 'actual', accountedTokens: 0, reservedTokens: 132 });
    expect(
      mediaTextLedgerEntry({ dispatched: true, promptBytes: 400, providerTokens: 377 }),
    ).toMatchObject({ measurement: 'actual', accountedTokens: 377 });
    expect(
      mediaTextLedgerEntry({ dispatched: true, promptBytes: 400, providerTokens: null }),
    ).toMatchObject({ measurement: 'estimated', accountedTokens: 132 });
    // 发出去了但长度依据也没有：整笔文本预占记未知。
    expect(
      mediaTextLedgerEntry({ dispatched: true, promptBytes: 0, providerTokens: null }),
    ).toMatchObject({ measurement: 'unknown', accountedTokens: null, reservedTokens: 32 });
  });

  it('空台账重算得到零而不是崩溃；未知与未结算都没有时账单为完整', () => {
    const empty = summarizeMediaUsage([]);
    expect(empty.total.calls).toBe(0);
    expect(empty.hasUnaccounted).toBe(false);
    expect(empty.byKind).toEqual([]);
    const clean = mediaLedgerForRun('run-2', [observation('ok')]);
    expect(clean.hasUnaccounted).toBe(false);
    expect(clean.unsettled).toEqual([]);
  });
});
