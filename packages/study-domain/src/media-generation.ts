import {
  StudyError,
  MEDIA_FAILURE_KIND,
  MEDIA_PRIMARY_USAGE,
  zeroMediaUsage,
  type ModelCostMeasurement,
  type ModelUsageMeasurement,
  type MediaFailureKind,
  type MediaGenerationCommandDto,
  type MediaProductRefDto,
  type MediaTaskKind,
  type MediaTaskState,
  type MediaTaskUsageDto,
  type MediaUsageLedgerDto,
  type MediaUsageObservationDto,
  type MediaUsageQuantitiesDto,
  type MediaUsageSummaryDto,
} from '@sew/study-contracts';

/**
 * 媒体生成的纯判定（OMA-060…065 领域层）。
 *
 * 这里没有任何 IO：不联网、不落盘、不发音。它只回答四件事——
 * 1. 这次派发该不该发生：缺 provider、断网、run 已终态、麦克风未授权，
 *    全部在任何外部请求发出之前明确失败，绝不「先发再报错」；
 * 2. 任务状态机怎么推进：`started → completed / failed`，终态不可再动，
 *    杜绝断线重放把一次生成记成两次用量；
 * 3. 产物能否入账：completed 必须有真实落盘的产物引用，failed 一律不收产物——
 *    失败不伪造产物；产物只是候选，进不了权威；
 * 4. 用量怎么记：实际 / 估算 / 未知 / 未结算预占四档分列，未知不按 0 计，
 *    同一批观察记录重算必须得到同一个分类账（OMA-065 的「可重算」）。
 *
 * 口径与文本台账（`model-usage.ts` / `budget.ts`）严格同构，只是计量维度
 * 从 token 换成「张数 / 秒 / 字符」；文本维度（提示词、转写结果）另由
 * `mediaTextLedgerEntry` 换算进共享的 `ModelUsageCallDto` 额度。
 */

const MEDIA_FAILURE_KIND_SET: ReadonlySet<string> = new Set<string>(MEDIA_FAILURE_KIND);

const emptyQuantities = (): MediaUsageQuantitiesDto => ({
  tokens: 0,
  images: 0,
  seconds: 0,
  characters: 0,
});

/** 把一笔用量并入维度合计：`null` 维度视为无数据，不并入也不报错（口径在桶级别判）。 */
const addUsageTo = (target: MediaUsageQuantitiesDto, usage: MediaTaskUsageDto): void => {
  target.images += usage.images ?? 0;
  target.characters += usage.characters ?? 0;
  target.seconds += (usage.videoSeconds ?? 0) + (usage.audioSeconds ?? 0) + (usage.asrSeconds ?? 0);
  target.tokens += usage.tokens.totalTokens ?? 0;
};

const addQuantities = (target: MediaUsageQuantitiesDto, part: MediaUsageQuantitiesDto): void => {
  target.tokens += part.tokens;
  target.images += part.images;
  target.seconds += part.seconds;
  target.characters += part.characters;
};

const isZeroQuantities = (value: MediaUsageQuantitiesDto): boolean =>
  value.tokens === 0 && value.images === 0 && value.seconds === 0 && value.characters === 0;

/**
 * 一笔媒体观察记录占用哪些额度——判定顺序与 `consumptionOf` 同源，先看是否结算，再看口径：
 * - 仍在 `started` → 整笔预占记「未结算」，继续占额度（钱和时间可能已经花出去）；
 * - `actual` → 记实际，预占释放；
 * - `estimated` → 记估算（有可复核依据，不该按未知扣着），差额释放；
 * - `unknown`（已终态但没有依据）→ 整笔预占记「未知」，绝不按 0 计。
 * `actual/estimated` 出现空结算值按保守回落「未知」，不放行成 0。
 */
export const mediaConsumptionOf = (
  observation: MediaUsageObservationDto,
): {
  actual: MediaUsageQuantitiesDto;
  estimated: MediaUsageQuantitiesDto;
  unknown: MediaUsageQuantitiesDto;
  unsettled: MediaUsageQuantitiesDto;
} => {
  const actual = emptyQuantities();
  const estimated = emptyQuantities();
  const unknown = emptyQuantities();
  const unsettled = emptyQuantities();
  if (observation.state === 'started') {
    addUsageTo(unsettled, observation.reserved);
    return { actual, estimated, unknown, unsettled };
  }
  if (observation.usageMeasurement === 'actual' && observation.accounted !== null) {
    addUsageTo(actual, observation.accounted);
  } else if (observation.usageMeasurement === 'estimated' && observation.accounted !== null) {
    addUsageTo(estimated, observation.accounted);
  } else {
    addUsageTo(unknown, observation.reserved);
  }
  return { actual, estimated, unknown, unsettled };
};

/**
 * 媒体用量分类账（OMA-065「LLM/image/video/TTS/ASR 实际用量可重算」）。
 *
 * 分类账不是存储出来的数字，而是对观察记录集合的**纯重算**：
 * - 与顺序无关（对任意排列输入得到相同输出），界面显示的「实际用量」永远来自重算；
 * - 三档（实际/估算/未知）与未结算预占分列，绝不互相折算；
 * - `hasUnaccounted` 为 true 时账单不完整，界面不能把「实际」当总花费。
 */
export const summarizeMediaUsage = (
  observations: readonly MediaUsageObservationDto[],
): Omit<MediaUsageLedgerDto, 'runId'> => {
  const emptySummary = (): MediaUsageSummaryDto => ({
    calls: 0,
    actual: emptyQuantities(),
    estimated: emptyQuantities(),
    unknown: emptyQuantities(),
    unsettled: emptyQuantities(),
    elapsedMs: 0,
    actualCost: null,
    estimatedCost: null,
    unknownCostCalls: 0,
  });
  const total = emptySummary();
  const byKind = new Map<MediaTaskKind, MediaUsageSummaryDto>();
  const unsettled: MediaUsageLedgerDto['unsettled'] = [];

  for (const observation of observations) {
    const kindSummary = byKind.get(observation.kind) ?? emptySummary();
    const bucket = mediaConsumptionOf(observation);
    for (const target of [total, kindSummary]) {
      target.calls += 1;
      addQuantities(target.actual, bucket.actual);
      addQuantities(target.estimated, bucket.estimated);
      addQuantities(target.unknown, bucket.unknown);
      addQuantities(target.unsettled, bucket.unsettled);
      target.elapsedMs += Math.round(observation.elapsedMs ?? 0);
      if (observation.costMeasurement === 'unknown') target.unknownCostCalls += 1;
      else if (observation.cost !== null && observation.costMeasurement === 'actual')
        target.actualCost = (target.actualCost ?? 0) + observation.cost;
      else if (observation.cost !== null && observation.costMeasurement === 'estimated')
        target.estimatedCost = (target.estimatedCost ?? 0) + observation.cost;
    }
    if (observation.state === 'started') {
      unsettled.push({
        taskId: observation.taskId,
        kind: observation.kind,
        reserved: observation.reserved,
        createdAt: observation.createdAt,
      });
    }
    byKind.set(observation.kind, kindSummary);
  }

  const kinds: readonly MediaTaskKind[] = ['image', 'video', 'tts', 'asr'];
  return {
    total,
    byKind: kinds
      .filter((kind) => byKind.has(kind))
      .map((kind) => ({ kind, summary: byKind.get(kind)! })),
    unsettled,
    hasUnaccounted: !isZeroQuantities(total.unknown) || !isZeroQuantities(total.unsettled),
  };
};

/** 分类账贴 run 身份：重算本身保持纯函数，run 只在出口绑定。 */
export const mediaLedgerForRun = (
  runId: string,
  observations: readonly MediaUsageObservationDto[],
): MediaUsageLedgerDto => ({
  ...summarizeMediaUsage(observations),
  runId,
});

/**
 * 派发前的预算判定（与 `assertSharedBudget` 同一形状，维度换成媒体单位）。
 *
 * 三个维度（张数 / 秒 / 字符）加 token 任一不足都在请求发出之前失败，
 * 因此不存在「先生成再报额度不足」；`reason` 指出是哪个维度不足。
 */
export const assertMediaBudget = (facts: {
  limits: MediaUsageQuantitiesDto;
  used: MediaUsageQuantitiesDto;
  reserved: MediaUsageQuantitiesDto;
}): void => {
  const dimensions: (keyof MediaUsageQuantitiesDto)[] = [
    'tokens',
    'images',
    'seconds',
    'characters',
  ];
  for (const dimension of dimensions) {
    if (facts.used[dimension] + facts.reserved[dimension] > facts.limits[dimension]) {
      throw new StudyError('BUDGET_EXCEEDED', {
        reason: `media_${dimension}`,
        used: facts.used[dimension],
        reserved: facts.reserved[dimension],
        limit: facts.limits[dimension],
      });
    }
  }
};

/**
 * 按命令折算派发预占：主维度上界来自命令本身（张数 / 秒 / 字符）。
 * 文本维度不并进这里——提示词的 token 预占走 `mediaTextLedgerEntry`，
 * 以免把「计费字符数」（TTS）与「提示词长度」（图像/视频）混进同一格。
 */
export const mediaReservationOf = (command: MediaGenerationCommandDto): MediaUsageQuantitiesDto => {
  const quantities = emptyQuantities();
  switch (command.kind) {
    case 'image':
      quantities.images += command.count;
      break;
    case 'video':
      quantities.seconds += command.durationSeconds;
      break;
    case 'tts':
      // TTS 合成时长不可提前确知，秒数留给结算口径判；预占按待合成文本字符计。
      quantities.characters += command.text.length;
      break;
    case 'asr':
      quantities.seconds += command.audioSeconds;
      break;
  }
  return quantities;
};

/**
 * 派发前判定：缺 provider、断网、run 已终态、本地引擎缺少录音授权，
 * 全部在任何外部请求发出之前抛出**明确失败**（OMA-066 的前半段口径，
 * 但错误来自媒体派发判断本身，不碰既有文本台账）。
 * 本地 ASR（FunASR/Whisper）不依赖远端 provider 与网络，只依赖本地引擎与授权。
 */
export const assertMediaGenerationAdmitted = (facts: {
  command: MediaGenerationCommandDto;
  providerConfigured: boolean;
  /** null 表示「连接状态未知/断网」：与 false 同样拒绝派发。 */
  networkAvailable: boolean | null;
  runTerminated: boolean;
}): void => {
  if (facts.runTerminated) {
    throw new StudyError('RUN_TERMINATED', {
      reason: 'media_run_terminated',
      requestId: facts.command.requestId,
    });
  }
  const command = facts.command;
  // 本地 ASR（FunASR/Whisper）与无 Network 的本机 ComfyUI 工作流不依赖远端 provider 与网络。
  const offlineCapable =
    (command.kind === 'asr' && command.engine !== 'remote') ||
    (command.kind === 'image' && command.workflowLocation === 'local');
  if (!offlineCapable) {
    if (!facts.providerConfigured) {
      throw new StudyError('MODEL_NOT_CONFIGURED', {
        reason: 'media_provider_not_configured',
        provider: command.provider,
        kind: command.kind,
      });
    }
    if (facts.networkAvailable !== true) {
      throw new StudyError('MODEL_NOT_CONFIGURED', {
        reason: 'media_no_connection',
        provider: command.provider,
      });
    }
  }
  if (command.kind === 'asr' && command.engine !== 'remote' && !command.microphoneGranted) {
    // 录音授权是本地 ASR 唯一的派发前提：拒绝即明确失败，界面引导用户授权后重试。
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'media_microphone_not_granted' });
  }
};

/**
 * 产物只能作为候选进待核区。合同的字面量已经把 `authority` 钉死为 false，
 * 这里再判一次：即便有人绕过 schema 手工构造对象，也拒绝把它当成权威记录入账。
 */
export const assertMediaProductCandidate = (product: MediaProductRefDto): void => {
  if (product.authority !== false || product.reviewStatus !== 'pending_review') {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'media_product_not_candidate',
      assetId: product.assetId,
    });
  }
};

/** completed 与 failed 的入账校验：状态机、产物、主维度依据一次判完。 */
const assertMediaCompletion = (facts: {
  state: MediaTaskState;
  kind: MediaTaskKind;
  next: MediaTaskState;
  products: readonly MediaProductRefDto[];
}): void => {
  const allowed: Record<MediaTaskState, readonly MediaTaskState[]> = {
    started: ['completed', 'failed'],
    completed: [],
    failed: [],
  };
  if (!allowed[facts.state].includes(facts.next)) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'media_task_already_settled',
      state: facts.state,
      next: facts.next,
    });
  }
  if (facts.next === 'failed' && facts.products.length > 0) {
    // 失败不伪造产物：半成品、外部 URL、「顺手拿回来的」文件都不入账。
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'media_failed_task_rejects_products',
      products: facts.products.length,
    });
  }
  if (facts.next === 'completed') {
    if (facts.products.length === 0) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'media_products_missing' });
    }
    for (const product of facts.products) {
      assertMediaProductCandidate(product);
      if (product.kind !== facts.kind) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'media_product_kind_mismatch',
          productKind: product.kind,
        });
      }
    }
  }
};

/**
 * 派发时预占、结算时定档。`started` 的观察记录携带：
 * 未结算（`accounted === null`）；实际/估算（有依据，差额释放）；
 * 未知（拿不到任何依据，整笔预占继续占用）。这是全仓唯一的媒体结算口径实现，
 * 生产路径与测试都调用它，避免两处各写一遍而漂移。
 */
export const mediaSettlement = (facts: {
  dispatched: boolean;
  providerUsage: MediaTaskUsageDto | null;
  estimatedUsage: MediaTaskUsageDto | null;
}): {
  measurement: ModelUsageMeasurement;
  accounted: MediaTaskUsageDto | null;
  keepsReservation: boolean;
} => {
  // 请求根本没发出 → 消耗确知为 0，按实际记并释放预占。
  if (!facts.dispatched)
    return { measurement: 'actual', accounted: zeroMediaUsage(), keepsReservation: false };
  if (facts.providerUsage !== null)
    return { measurement: 'actual', accounted: facts.providerUsage, keepsReservation: false };
  if (facts.estimatedUsage !== null)
    return { measurement: 'estimated', accounted: facts.estimatedUsage, keepsReservation: false };
  return { measurement: 'unknown', accounted: null, keepsReservation: true };
};

/** 没有价格依据时费用保持未知，不返回 0 元——与文本侧 `costMeasurement` 同一规则。 */
export const mediaCostMeasurement = (facts: {
  priceKnown: boolean;
  tokensKnown: boolean;
  cost: number | null;
  costIsEstimate: boolean;
}): { cost: number | null; measurement: ModelCostMeasurement } => {
  if (!facts.priceKnown || !facts.tokensKnown || facts.cost === null)
    return { cost: null, measurement: 'unknown' };
  return { cost: facts.cost, measurement: facts.costIsEstimate ? 'estimated' : 'actual' };
};

/**
 * 结算写回（纯函数）：把一条 `started` 观察记录推进为终态。
 *
 * - 状态机与产物校验先做（`assertMediaCompletion`）；
 * - `completed` 必须有覆盖该用途**主维度**的用量依据：provider 回包优先，
 *   本地可复核估算次之，两者都没有就拒绝入账——宁可让调用方补证据，不替它编数字；
 * - `failed` 不要求用量依据（拿不到就按 unknown 保留预占），但必须给出确定
 *   `failureKind`，`unknown_outcome` 只留给断线后无法归因的情形；
 * - 结算用量超出预占时拒绝（`media_usage_exceeds_reservation`），
 *   调用方须先按共享预算重新预占，分类账里不会出现凭空多出来的消耗。
 */
export const settleMediaTask = (facts: {
  observation: MediaUsageObservationDto;
  next: MediaTaskState;
  products: readonly MediaProductRefDto[];
  failureKind?: MediaFailureKind;
  providerUsage: MediaTaskUsageDto | null;
  estimatedUsage: MediaTaskUsageDto | null;
  priceKnown: boolean;
  cost: number | null;
  costIsEstimate: boolean;
  elapsedMs: number | null;
  nowIso: string;
}): MediaUsageObservationDto => {
  const { observation } = facts;
  assertMediaCompletion({
    state: observation.state,
    kind: observation.kind,
    next: facts.next,
    products: facts.products,
  });
  if (
    facts.next === 'failed' &&
    !(facts.failureKind && MEDIA_FAILURE_KIND_SET.has(facts.failureKind))
  ) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'media_failure_kind_missing' });
  }
  const settlement = mediaSettlement({
    dispatched: observation.dispatched,
    providerUsage: facts.providerUsage,
    estimatedUsage: facts.estimatedUsage,
  });
  if (facts.next === 'completed') {
    if (settlement.accounted === null) {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'media_usage_evidence_missing',
        kind: observation.kind,
      });
    }
    const missing = MEDIA_PRIMARY_USAGE[observation.kind].filter(
      (dimension) => settlement.accounted !== null && settlement.accounted[dimension] === null,
    );
    if (missing.length > 0) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'media_usage_evidence_missing', missing });
    }
    const exceeded = (
      ['images', 'videoSeconds', 'characters', 'audioSeconds', 'asrSeconds'] as const
    ).find(
      (dimension) =>
        (settlement.accounted?.[dimension] ?? 0) > (observation.reserved[dimension] ?? 0),
    );
    if (exceeded !== undefined) {
      throw new StudyError('BUDGET_EXCEEDED', {
        reason: 'media_usage_exceeds_reservation',
        dimension: exceeded,
      });
    }
  }
  const cost = mediaCostMeasurement({
    priceKnown: facts.priceKnown,
    tokensKnown: settlement.measurement !== 'unknown',
    cost: facts.cost,
    costIsEstimate: facts.costIsEstimate,
  });
  return {
    ...observation,
    state: facts.next,
    // completed 恒无失败原因；failed 必带原因，缺省按「结果未知」如实标注。
    failureKind: facts.next === 'failed' ? (facts.failureKind ?? 'unknown_outcome') : null,
    usageMeasurement: settlement.measurement,
    accounted: settlement.accounted,
    elapsedMs: facts.elapsedMs,
    cost: cost.cost,
    costMeasurement: cost.measurement,
    updatedAt: facts.nowIso,
  };
};

/**
 * 视频任务状态查询返回值 → 任务终态判定（OMA-061）。
 *
 * provider 说 `succeeded` 但产物拿不到（取不到 URL、下载失败、落盘校验不过）时按失败处理——
 * 「真实任务与产物落盘，生成失败不计成功」（OMA-060/061 验收）。
 */
export const mediaPollOutcome = (facts: {
  providerState: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  productsAvailable: boolean;
}): { terminal: boolean; state: MediaTaskState | null; failureKind: MediaFailureKind | null } => {
  if (facts.providerState === 'queued' || facts.providerState === 'running') {
    return { terminal: false, state: null, failureKind: null };
  }
  if (facts.providerState === 'cancelled')
    return { terminal: true, state: 'failed', failureKind: 'cancelled' };
  if (facts.providerState === 'failed')
    return { terminal: true, state: 'failed', failureKind: 'provider_error' };
  if (!facts.productsAvailable)
    return { terminal: true, state: 'failed', failureKind: 'provider_error' };
  return { terminal: true, state: 'completed', failureKind: null };
};

/**
 * 轮询节拍判定（纯函数，调用方自己持有定时器；本层不 setTimeout）。
 *
 * 判定顺序固定：失败 → 成功 → 取消 → 墙钟超时 → 次数用尽 → 继续等。
 * 取消优先于超时：用户明确表达 over 系统推断。剩余墙钟小于间隔时按剩余时间等，
 * 保证最后一次轮询不会「过了 deadline 还在查」。
 */
export const mediaPollDecision = (facts: {
  providerState: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  productsAvailable: boolean;
  cancelled: boolean;
  elapsedMs: number;
  deadlineMs: number;
  intervalMs: number;
  pollsDone: number;
  maxPolls: number;
}): {
  action: 'continue' | 'succeeded' | 'failed';
  failureKind: MediaFailureKind | null;
  nextPollInMs: number | null;
} => {
  if (facts.elapsedMs < 0 || facts.deadlineMs <= 0 || facts.intervalMs <= 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'media_poll_facts_invalid' });
  }
  if (facts.providerState === 'failed') {
    return { action: 'failed', failureKind: 'provider_error', nextPollInMs: null };
  }
  const outcome = mediaPollOutcome({
    providerState: facts.providerState,
    productsAvailable: facts.productsAvailable,
  });
  if (outcome.terminal && outcome.state === 'completed') {
    return { action: 'succeeded', failureKind: null, nextPollInMs: null };
  }
  if (facts.cancelled) {
    return { action: 'failed', failureKind: 'cancelled', nextPollInMs: null };
  }
  if (facts.elapsedMs >= facts.deadlineMs) {
    return { action: 'failed', failureKind: 'deadline_exceeded', nextPollInMs: null };
  }
  if (outcome.terminal && outcome.state === 'failed') {
    return { action: 'failed', failureKind: outcome.failureKind, nextPollInMs: null };
  }
  if (facts.pollsDone >= facts.maxPolls) {
    return { action: 'failed', failureKind: 'poll_limit_exceeded', nextPollInMs: null };
  }
  return {
    action: 'continue',
    failureKind: null,
    nextPollInMs: Math.min(facts.intervalMs, facts.deadlineMs - facts.elapsedMs),
  };
};

/**
 * 取消（四类任务通用）：只有还在跑的调用可以取消；终态取消被拒，
 * 「取消」不能变成第二次结算的入口。
 *
 * 已派发 → 「钱可能花了，结果不知道」：观察记录按 unknown 口径保留预占，
 * 失败原因记 `cancelled`；未派发 → 消耗确知 0，按 actual 结算并释放预占。
 * 两种情况产物都恒为空——取消不伪造任何产物。
 */
export const cancelMediaTask = (facts: {
  observation: MediaUsageObservationDto;
  nowIso: string;
}): { observation: MediaUsageObservationDto; products: []; keepReservation: boolean } => {
  if (facts.observation.state !== 'started') {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'media_task_already_settled',
      state: facts.observation.state,
      next: 'failed',
    });
  }
  const settlement = mediaSettlement({
    dispatched: facts.observation.dispatched,
    providerUsage: null,
    estimatedUsage: null,
  });
  // 「取消」这一失败原因确定，不算 unknown_outcome；但用量口径仍按证据走（没依据就保留预占）。
  return {
    observation: {
      ...facts.observation,
      state: 'failed',
      failureKind: 'cancelled',
      usageMeasurement: settlement.measurement,
      accounted: settlement.accounted,
      updatedAt: facts.nowIso,
    },
    products: [],
    keepReservation: settlement.keepsReservation,
  };
};

/**
 * 断线/重开后的恢复判定：未结算任务不自动重放，保留预占（与文本侧
 * `resumePolicyForUnsettled` 同一规则）。已终态任务直接复用既有结算，
 * 界面不得再显示为「可重试免费再来一次」。
 */
export const mediaResumePolicy = (facts: {
  state: MediaTaskState;
}): {
  policy: 'refuse_auto_replay' | 'reuse_settled';
  keepReservation: boolean;
} => {
  if (facts.state === 'started') return { policy: 'refuse_auto_replay', keepReservation: true };
  return { policy: 'reuse_settled', keepReservation: false };
};

/**
 * 终态读出判定：`failed + unknown_outcome` 必须读成「结果未知」，
 * 既不显示成功，也不显示「未花钱」。这是给界面的口径，防止把断线任务渲染成可安全重试。
 */
export const mediaTaskOutcome = (
  observation: MediaUsageObservationDto,
): {
  state: MediaTaskState;
  showsAsFailed: boolean;
  outcomeKnown: boolean;
  keepsReservation: boolean;
} => {
  if (observation.state === 'started') {
    return { state: 'started', showsAsFailed: false, outcomeKnown: false, keepsReservation: true };
  }
  const unknownOutcome =
    observation.state === 'failed' && observation.failureKind === 'unknown_outcome';
  return {
    state: observation.state,
    showsAsFailed: observation.state === 'failed',
    outcomeKnown: !unknownOutcome,
    keepsReservation: mediaConsumptionOfIsUnaccounted(observation),
  };
};

const mediaConsumptionOfIsUnaccounted = (observation: MediaUsageObservationDto): boolean => {
  const bucket = mediaConsumptionOf(observation);
  return !isZeroQuantities(bucket.unknown) || !isZeroQuantities(bucket.unsettled);
};

/**
 * 文本维度换算（进既有 `ModelUsageCallDto`，purpose 由调用方选定）：
 * provider 回了 token → actual；没回但有提示词长度 → 保守估算（bytes/4，含 32 固定开销）；
 * 派发过又什么都没有 → unknown，整笔文本预占保留。
 * 与 `reserveSharedModelTokens` 同一保守方向：估算只用于释放差额，不用于压低成本。
 */
export const mediaTextLedgerEntry = (facts: {
  dispatched: boolean;
  promptBytes: number;
  providerTokens: number | null;
}): {
  measurement: ModelUsageMeasurement;
  accountedTokens: number | null;
  reservedTokens: number;
} => {
  const reservedTokens = Math.max(1, Math.ceil(facts.promptBytes / 4) + 32);
  if (!facts.dispatched) return { measurement: 'actual', accountedTokens: 0, reservedTokens };
  if (facts.providerTokens !== null)
    return { measurement: 'actual', accountedTokens: facts.providerTokens, reservedTokens };
  if (facts.promptBytes > 0) {
    const estimatedTokens = Math.min(
      reservedTokens,
      Math.max(1, Math.ceil(facts.promptBytes / 4) + 32),
    );
    return { measurement: 'estimated', accountedTokens: estimatedTokens, reservedTokens };
  }
  // 发出去了、token 与长度依据都拿不到：整笔文本预占记未知，绝不按 0 计。
  return { measurement: 'unknown', accountedTokens: null, reservedTokens };
};
