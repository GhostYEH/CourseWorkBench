import { z } from 'zod';
import { MODEL_COST_MEASUREMENT, MODEL_USAGE_MEASUREMENT } from './model-usage';

/**
 * 媒体生成合同（OMA-060 图像、OMA-061 视频、OMA-062 TTS、OMA-063 音色、OMA-064 ASR、OMA-065 用量）。
 *
 * 这一层只描述「一次外部媒体生成该怎么发、怎么记、产物该落在哪」，不做判定：
 * - 命令只描述这次生成请求本身（提示词、尺寸、音色、录音时长等），不携带教学事实，
 *   也不接受渲染层提交的密钥；provider 与凭据沿用 `model-connection` 那套写入即弃的纪律；
 * - 任务状态只有 `started | failed | completed`，与模型调用台账同一套口径；缺 provider、断网、
 *   取消、超时、轮询用满一律落 `failed` 并给出 `failureKind`，不允许「没有产物却是 completed」；
 * - 产物（`mediaProductRefSchema`）只能作为**候选**进待核区：`authority` 恒为字面量 false、
 *   `reviewStatus` 恒为 `pending_review`。是否接入课件由既有审核与来源纪律决定，
 *   本层不表示已核实、不进入任何权威记录，也不新增待核区状态；
 * - 用量沿用台账三档口径（实际 / 估算 / 未知，见 `model-usage`），未知绝不按 0 计；
 *   `accounted` 某维度为 null 表示「当时拿不到依据」，为 0 表示「确知没有消耗」；
 * - 计费维度按用途分开：图像按张数，视频/音频/转写按秒，TTS 按字符，tokens 只承接共享文本额度。
 */

/** 媒体任务类型，与机器清单 `providers_media` 的四类生成一一对应。 */
export const MEDIA_TASK_KIND = ['image', 'video', 'tts', 'asr'] as const;
export type MediaTaskKind = (typeof MEDIA_TASK_KIND)[number];

/** 任务状态机取值：与 `model_usage_calls.state` 同一套 started/failed/completed。 */
export const MEDIA_TASK_STATE = ['started', 'failed', 'completed'] as const;
export type MediaTaskState = (typeof MEDIA_TASK_STATE)[number];

/**
 * 失败原因。断网与缺 provider 是两种明确失败，不合并成「未知错误」；
 * 取消、超时、轮询次数用满也是确定原因；已派发却拿不到任何依据记 `unknown_outcome`
 * ——它同样不是成功，界面必须显示「结果未知」而不是空白或成功。
 */
export const MEDIA_FAILURE_KIND = [
  'no_connection',
  'provider_not_configured',
  'provider_error',
  'local_engine_unavailable',
  'permission_denied',
  'recorder_unavailable',
  'cancelled',
  'deadline_exceeded',
  'poll_limit_exceeded',
  'unknown_outcome',
] as const;
export type MediaFailureKind = (typeof MEDIA_FAILURE_KIND)[number];

/** 工作流执行位置：本机 ComfyUI 与远端图像服务分开登记，失败与额度差异才有出处（OMA-060）。 */
export const MEDIA_WORKFLOW_LOCATION = ['local', 'remote'] as const;
export type MediaWorkflowLocation = (typeof MEDIA_WORKFLOW_LOCATION)[number];

/**
 * 音色来源（OMA-063）。`preset` 是服务商预置，`design` 由用户描述文本合成，
 * `clone` 需要一段参考音频。三者只描述「怎么用这个音色」，不表示该音色已被授权进教学内容。
 */
export const MEDIA_VOICE_SOURCE = ['preset', 'design', 'clone'] as const;
export type MediaVoiceSource = (typeof MEDIA_VOICE_SOURCE)[number];

/** 播放速度倍率边界（OMA-062）。倍率是「怎么听」，不改变音频产物本身。 */
export const MEDIA_PLAYBACK_SPEED = { min: 0.5, max: 2 } as const;

/** 视频轮询节奏上界（OMA-061）：间隔、次数、墙钟都有界，任务不会永远停在「还在查」。 */
export const MEDIA_POLL_LIMITS = {
  maxIntervalMs: 600_000,
  maxPolls: 2_000,
  maxDeadlineMs: 6 * 3_600_000,
} as const;

const idSchema = z.string().trim().min(1).max(200);
/** provider / 模型标识只允许进路径与日志的安全字符集。 */
const providerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:@-]+$/, 'provider 标识只能包含字母、数字与 . _ : @ -');
const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.\-:/]+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, '需要小写十六进制 sha256');
const mimeSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, '需要形如 image/png 的 MIME');
const nullableCount = z.number().int().nonnegative().nullable();
const nullableAmount = z.number().nonnegative().nullable();
/** 产物字节上界 2 GiB：超出就该走项目资源库分块，不放室内联引用。 */
const byteLengthSchema = z
  .number()
  .int()
  .nonnegative()
  .max(2 * 1024 ** 3);

/**
 * 文本维度用量。图像/视频按张数与秒数计量，但提示词与返回的文本描述仍消耗同一份
 * run 的 token 额度，所以这一维度必须能换算进既有 `ModelUsageCallDto`（见 domain 的
 * `mediaTextLedgerEntry`）。
 */
export const mediaTokenUsageSchema = z
  .object({
    promptTokens: nullableCount,
    completionTokens: nullableCount,
    totalTokens: nullableCount,
  })
  .strict();
export type MediaTokenUsageDto = z.infer<typeof mediaTokenUsageSchema>;

/**
 * 一次任务的计费用量。三组单位互不重叠：文本（`tokens`）、时长（`seconds` 系）、图像张数（`images`）。
 * 维度为 `null` = 当时没有可复核依据；为 `0` = 确知该维度没有消耗。两者口径完全不同。
 */
export const mediaTaskUsageSchema = z
  .object({
    tokens: mediaTokenUsageSchema,
    images: nullableCount,
    /** 视频秒数（OMA-061）。 */
    videoSeconds: nullableAmount,
    /** TTS 计费字符数与合成音频秒数（OMA-062）。 */
    characters: nullableCount,
    audioSeconds: nullableAmount,
    /** ASR 输入音频秒数（OMA-064）。 */
    asrSeconds: nullableAmount,
  })
  .strict();
export type MediaTaskUsageDto = z.infer<typeof mediaTaskUsageSchema>;

/** 全零用量：只用于「确知没有消耗」（例如请求根本没发出）。未知不走这里。 */
export const zeroMediaUsage = (): MediaTaskUsageDto => ({
  tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  images: 0,
  videoSeconds: 0,
  characters: 0,
  audioSeconds: 0,
  asrSeconds: 0,
});

/**
 * 每种任务**必须**拿到依据的计量维度。缺主维度就不许按 completed 入账——
 * 要么补依据，要么按 unknown 保守计，不允许静默记 0。
 */
export const MEDIA_PRIMARY_USAGE: Record<MediaTaskKind, readonly (keyof MediaTaskUsageDto)[]> = {
  image: ['images'],
  video: ['videoSeconds'],
  tts: ['characters'],
  asr: ['asrSeconds'],
};

/**
 * 生成命令公共字段。派发层按 `kind` 分派并立刻登记一条 `started` 观察记录；
 * 取消与超时是对这条记录的状态推进，不是另一种命令，所以这里没有 `action` 字段。
 * `requestId` 与 intent（sha256）由服务端生成：同一 `requestId` 不得换参数重复派发。
 * 转写类命令没有「提示词」概念，所以 `prompt` 按用途各就各位，不做公共字段。
 */
const commandBase = {
  scope: z
    .object({
      projectId: z.string().min(1).max(200),
      generation: z.number().int().nonnegative(),
      runId: idSchema,
    })
    .strict(),
  requestId: idSchema,
  provider: providerIdSchema,
  model: modelIdSchema.optional(),
  /** 关联的已审核课程/场景，便于产物候选回填待核区；未关联为 null。 */
  lessonId: z.string().min(1).max(200).nullable().optional(),
};

/** 图像生成命令（OMA-060）。ComfyUI 工作流用 `workflowId` + 固定参数表描述，不接受任意 JSON。 */
export const imageGenerationCommandSchema = z
  .object({
    ...commandBase,
    kind: z.literal('image'),
    /** 面向 provider 的生成请求正文：不是教学事实，也不接受密钥。 */
    prompt: z.string().trim().min(1).max(8_000),
    negativePrompt: z.string().trim().max(4_000).optional(),
    workflowId: idSchema,
    workflowLocation: z.enum(MEDIA_WORKFLOW_LOCATION),
    width: z.number().int().min(64).max(4_096),
    height: z.number().int().min(64).max(4_096),
    steps: z.number().int().min(1).max(200),
    guidance: z.number().nonnegative().max(30),
    seed: z.number().int().nullable().optional(),
    count: z.number().int().min(1).max(16),
    /** 参考图只能引用已入库资产编号，外部 URL 与本机路径一律拒绝。 */
    referenceAssetId: idSchema.optional(),
  })
  .strict();
export type ImageGenerationCommandDto = z.infer<typeof imageGenerationCommandSchema>;

/** 视频生成命令（OMA-061）。轮询间隔、次数与墙钟必须在派发时定下来，不能事后由界面猜。 */
export const videoGenerationCommandSchema = z
  .object({
    ...commandBase,
    kind: z.literal('video'),
    /** 面向 provider 的生成请求正文：不是教学事实，也不接受密钥。 */
    prompt: z.string().trim().min(1).max(8_000),
    negativePrompt: z.string().trim().max(4_000).optional(),
    firstFrameAssetId: idSchema.optional(),
    durationSeconds: z.number().nonnegative().min(1).max(600),
    aspectRatio: z.string().trim().max(20).optional(),
    poll: z
      .object({
        intervalMs: z.number().int().positive().max(MEDIA_POLL_LIMITS.maxIntervalMs),
        maxPolls: z.number().int().positive().max(MEDIA_POLL_LIMITS.maxPolls),
        deadlineMs: z.number().int().positive().max(MEDIA_POLL_LIMITS.maxDeadlineMs),
      })
      .strict(),
  })
  .strict();
export type VideoGenerationCommandDto = z.infer<typeof videoGenerationCommandSchema>;

/** TTS 命令（OMA-062）。播放速度随产物记录；倍率只影响回放，不改变文本与音频的对应关系。 */
export const ttsGenerationCommandSchema = z
  .object({
    ...commandBase,
    kind: z.literal('tts'),
    text: z.string().min(1).max(20_000),
    voiceId: idSchema,
    /** 教师/AI 同学档案编号：多个角色音色可区分（OMA-062 验收）。 */
    roleProfileId: idSchema.optional(),
    playbackRate: z.number().min(MEDIA_PLAYBACK_SPEED.min).max(MEDIA_PLAYBACK_SPEED.max).default(1),
    locale: z.string().trim().min(2).max(35).optional(),
    /** 与音频对应的文本摘要：文本改了就须重新合成，不能沿用旧音频。 */
    textDigest: sha256Schema.optional(),
  })
  .strict();
export type TtsGenerationCommandDto = z.infer<typeof ttsGenerationCommandSchema>;

/** ASR 命令（OMA-064）。只接受本地音频资产 + 显式麦克风授权，不接受任意上传 URL。 */
export const asrGenerationCommandSchema = z
  .object({
    ...commandBase,
    kind: z.literal('asr'),
    engine: z.enum(['remote', 'local_funasr', 'local_whisper']),
    /** 授权必须由界面显式给出，服务端不推断「用户大概允许了」。 */
    microphoneGranted: z.boolean(),
    audioAssetId: idSchema.optional(),
    audioSeconds: z.number().nonnegative().min(0.1).max(3_600),
    locale: z.string().trim().min(2).max(35).optional(),
  })
  .strict();
export type AsrGenerationCommandDto = z.infer<typeof asrGenerationCommandSchema>;

/** 四类生成命令的联合：参数不共用宽松对象，按 `kind` 精确分派。 */
export const mediaGenerationCommandSchema = z.discriminatedUnion('kind', [
  imageGenerationCommandSchema,
  videoGenerationCommandSchema,
  ttsGenerationCommandSchema,
  asrGenerationCommandSchema,
]);
export type MediaGenerationCommandDto = z.infer<typeof mediaGenerationCommandSchema>;

/**
 * 产物引用（候选）。
 *
 * `reviewStatus` 只有 `pending_review` 一个取值、`authority` 只有 `false`：
 * 合同层面就没法把一次生成的图片/视频/音频写成权威内容。审核通过之后由既有的
 * 资源登记与课件绑定流程落地，本层不新增状态、也不表示「内容已核实」。
 * `sha256` + `byteLength` + `relativePath` 是「真实落盘」的最低证据：拿不到就不许入账。
 */
export const mediaProductRefSchema = z
  .object({
    taskId: idSchema,
    assetId: idSchema,
    kind: z.enum(MEDIA_TASK_KIND),
    sha256: sha256Schema,
    byteLength: byteLengthSchema,
    mime: mimeSchema,
    /** 项目内相对路径（例如 `media/img_1.png`）：不含本机绝对路径、反斜杠与外部 URL。 */
    relativePath: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          !value.startsWith('/') &&
          !value.includes('\\') &&
          !value.includes('://') &&
          !value.split('/').includes('..') &&
          !/^[A-Za-z]:/.test(value),
        '产物路径必须是项目内相对路径',
      ),
    /** 与既有课堂资源同一形状的视频/音频时长；图像为 null。 */
    durationSeconds: z
      .number()
      .nonnegative()
      .max(6 * 3_600)
      .nullable()
      .default(null),
    reviewStatus: z.literal('pending_review'),
    authority: z.literal(false),
    /** provider 侧任务标识：这张图/这段视频对应哪个远端任务，复查时不用猜。 */
    providerJobId: z.string().max(200).optional(),
    recordedAt: z.string().min(1).max(60),
  })
  .strict();
export type MediaProductRefDto = z.infer<typeof mediaProductRefSchema>;

/**
 * 音色档案（OMA-063）。`clone` 的参考音频按资产编号 + 摘要 + 时长登记，
 * 档案本身不内联二进制，也不保存任何 provider 凭据。
 */
export const mediaVoiceProfileSchema = z
  .object({
    voiceId: idSchema,
    provider: providerIdSchema,
    source: z.enum(MEDIA_VOICE_SOURCE),
    displayName: z.string().trim().min(1).max(60),
    /** `design` 的自然语言描述文本；`preset` 为空串。 */
    description: z.string().max(2_000).default(''),
    /** `clone` 的参考音频资产编号；非 clone 为 null。 */
    referenceAssetId: idSchema.nullable().default(null),
    referenceSha256: sha256Schema.nullable().default(null),
    referenceSeconds: z.number().nonnegative().max(600).nullable().default(null),
    defaultPlaybackRate: z
      .number()
      .min(MEDIA_PLAYBACK_SPEED.min)
      .max(MEDIA_PLAYBACK_SPEED.max)
      .default(1),
    language: z.string().trim().min(2).max(35).default('zh-CN'),
    createdAt: z.string().min(1).max(60),
    updatedAt: z.string().min(1).max(60),
  })
  .strict();
export type MediaVoiceProfileDto = z.infer<typeof mediaVoiceProfileSchema>;

/**
 * 一次媒体调用的观察记录。计量口径与 `model_usage_calls` 同源（actual/estimated/unknown），
 * 但维度换成媒体单位；这是重算用量分类账的唯一输入，界面不另存一份「大概用过」的数字。
 */
export const mediaUsageObservationSchema = z
  .object({
    projectId: idSchema,
    requestId: idSchema,
    runId: idSchema,
    taskId: idSchema,
    kind: z.enum(MEDIA_TASK_KIND),
    state: z.enum(MEDIA_TASK_STATE),
    /** 仅 `failed` 有值；`completed` 恒为 null。 */
    failureKind: z.enum(MEDIA_FAILURE_KIND).nullable().default(null),
    /** 请求是否真的发出过。未派发时消耗确知为 0。 */
    dispatched: z.boolean(),
    /** 全维度用量口径，语义与 `tokenMeasurement` 一致。 */
    usageMeasurement: z.enum(MODEL_USAGE_MEASUREMENT),
    /** 已结算用量；`started` 与「派发过但拿不到依据」为 null。 */
    accounted: mediaTaskUsageSchema.nullable(),
    /** 派发时按命令上界预留的用量。 */
    reserved: mediaTaskUsageSchema,
    elapsedMs: z.number().nonnegative().nullable(),
    cost: nullableAmount,
    costMeasurement: z.enum(MODEL_COST_MEASUREMENT),
    createdAt: z.string().min(1).max(60),
    updatedAt: z.string().min(1).max(60),
  })
  .strict();
export type MediaUsageObservationDto = z.infer<typeof mediaUsageObservationSchema>;

/** 单档用量合计：token / 张数 / 秒（视频+音频+转写）/ 字符。 */
export const mediaUsageQuantitiesSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    seconds: z.number().nonnegative(),
    characters: z.number().int().nonnegative(),
  })
  .strict();
export type MediaUsageQuantitiesDto = z.infer<typeof mediaUsageQuantitiesSchema>;

/** 媒体用量小计：三档 + 未结算预占 + 耗时与费用。 */
export const mediaUsageSummarySchema = z
  .object({
    calls: z.number().int().nonnegative(),
    actual: mediaUsageQuantitiesSchema,
    estimated: mediaUsageQuantitiesSchema,
    unknown: mediaUsageQuantitiesSchema,
    /** 已派发未结算（`started`）的调用按预占继续占用额度，绝不按 0 计。 */
    unsettled: mediaUsageQuantitiesSchema,
    elapsedMs: z.number().int().nonnegative(),
    actualCost: z.number().nonnegative().nullable(),
    estimatedCost: z.number().nonnegative().nullable(),
    unknownCostCalls: z.number().int().nonnegative(),
  })
  .strict();
export type MediaUsageSummaryDto = z.infer<typeof mediaUsageSummarySchema>;

/** 一个 run 的媒体用量分类账（OMA-065「记录与查看」的展示形状）。 */
export const mediaUsageLedgerSchema = z
  .object({
    runId: idSchema,
    total: mediaUsageSummarySchema,
    byKind: z.array(
      z
        .object({
          kind: z.enum(MEDIA_TASK_KIND),
          summary: mediaUsageSummarySchema,
        })
        .strict(),
    ),
    /** 已派发未结算的任务：界面要能指出「这段时间/这张图花在哪，结果未知」。 */
    unsettled: z.array(
      z
        .object({
          taskId: idSchema,
          kind: z.enum(MEDIA_TASK_KIND),
          reserved: mediaTaskUsageSchema,
          createdAt: z.string().max(60),
        })
        .strict(),
    ),
    /** 账单是否仍含未知/未结算：true 时「实际用量」不代表全部花费。 */
    hasUnaccounted: z.boolean(),
  })
  .strict();
export type MediaUsageLedgerDto = z.infer<typeof mediaUsageLedgerSchema>;
