/**
 * 课件导出与离线打包合同（OMA-067…072）。
 *
 * 导出是「把一份已冻结的课堂文档变成可移植、可复验的产物」，不是再生成一份新内容：
 * - 只导出**已审核发布**的课程版本，未发布/来源失效/审核后计划已变的版本一律拒绝；
 * - 场景内容与来源绑定逐字取自权威文档，导出过程不改写任何教学事实；
 * - 产物内每个条目都记录字节数与 sha256，导入或人工核对时可对照复验；
 * - 测验答案与判分依据在导出时被移除（与课堂渲染同源），分享产物不会泄露判分依据；
 * - 纯客户端组件（公式、字体、脚本等）以「离线资源清单」如实登记：已内联的写明内联，
 *   仍未内联的逐项列出缺口，不把外部 URL 或开发期绝对路径写进产物。
 *
 * 本项只落地**课件自包含 HTML + 媒体打包**（OMA-068/069/070/072）与确定性 ZIP 容器。
 * 可编辑 PowerPoint（OMA-067）与 MP4 视频导出（OMA-071）需要额外的文档/渲染服务，
 * 尚未实现，见对应能力清单条目的 evidence 缺口，不在此处伪装完成。
 */

import { z } from 'zod';
import { projectScopeSchema } from './api';

/** 导出容器结构版本。 */
export const LESSON_EXPORT_VERSION = 1;

/** 导出格式：当前只支持自包含 HTML 包；PowerPoint/MP4 未实现，显式拒绝而不是静默降级。 */
export const LESSON_EXPORT_FORMATS = ['html'] as const;
export type LessonExportFormat = (typeof LESSON_EXPORT_FORMATS)[number];

/** 离线资源的内联状态：`inlined` 表示已随包内联，`missing` 表示仍未内联（缺口必须可见）。 */
export const OFFLINE_RESOURCE_STATUS = ['inlined', 'missing'] as const;
export type OfflineResourceStatus = (typeof OFFLINE_RESOURCE_STATUS)[number];

/** 离线资源种类：公式、字体、脚本、图片等，逐类登记，便于人工核对。 */
export const OFFLINE_RESOURCE_KINDS = ['formula', 'font', 'script', 'image', 'other'] as const;
export type OfflineResourceKind = (typeof OFFLINE_RESOURCE_KINDS)[number];

/**
 * 单条离线资源。
 *
 * `reference` 是产物内的引用形状：内联时为 `data:`/包内相对路径，缺失时为**符号引用**
 * （例如 `katex`、`three.js`），绝不写外部 URL 或本机绝对路径。
 */
export const lessonExportResourceSchema = z
  .object({
    kind: z.enum(OFFLINE_RESOURCE_KINDS),
    reference: z.string().min(1).max(200),
    status: z.enum(OFFLINE_RESOURCE_STATUS),
    /** 缺口说明；已内联时为空串。 */
    note: z.string().max(500),
  })
  .strict();
export type LessonExportResourceDto = z.infer<typeof lessonExportResourceSchema>;

/**
 * 导出包清单（`manifest.json`）：产物身份、源课程身份与摘要、包内条目清单。
 *
 * `documentDigest` / `bundleDigest` / `planDigest` 绑定导出时的权威来源，导入或人工核对时
 * 能确认「导出的确实是这一版」。`entries` 给出包内每个文件的字节数与 sha256。
 */
export const lessonExportManifestSchema = z
  .object({
    containerVersion: z.literal(LESSON_EXPORT_VERSION),
    format: z.enum(LESSON_EXPORT_FORMATS),
    createdAt: z.string().datetime(),
    projectId: z.string().min(1).max(200),
    lessonId: z.string().min(1).max(200),
    lessonVersion: z.number().int().positive(),
    title: z.string().min(1).max(200),
    stageId: z.string().min(1).max(200),
    dslVersion: z.string().min(1).max(40),
    /** 权威课堂文档摘要（classroom_documents.digest），指向冻结源。 */
    documentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /**
     * **实际打包渲染**的文档摘要：已移除测验答案/解析/给分点后的投影。
     * 与 `documentDigest` 不同即可证明「分享产物不含判分依据」，而不是只在文案里声明。
     */
    exportedDocumentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    bundleDigest: z.string().min(1).max(200),
    /** 该版本的场景计划摘要；无计划时为 null（历史课程按「证据包即内容」）。 */
    planDigest: z.string().min(1).max(200).nullable(),
    sceneCount: z.number().int().nonnegative(),
    /** 包内条目（含 manifest.json 自身之外的所有文件），按路径排序。 */
    entries: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            byteLength: z
              .number()
              .int()
              .nonnegative()
              .max(2 * 1024 ** 3),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(20000),
    resources: z.array(lessonExportResourceSchema).max(500),
  })
  .strict();
export type LessonExportManifest = z.infer<typeof lessonExportManifestSchema>;

/** 导出请求：只指定课程版本与格式，产物内容由服务端从权威文档生成。 */
export const lessonExportSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('export-lesson'),
    lessonId: z.string().min(1),
    version: z.number().int().positive(),
    format: z.enum(LESSON_EXPORT_FORMATS).default('html'),
  })
  .strict();
export type LessonExportInput = z.infer<typeof lessonExportSchema>;

/**
 * 导出结果：给出产物落盘位置、摘要与逐项事实。
 *
 * 导出是同步成功即返回的命令；未发布/未审核/来源失效/审核后计划已改/写盘失败都在服务端抛
 * 领域错误（HTTP 错误响应），**不返回半成品结果**，因此这里没有 failed 态与可空产物字段。
 *
 * `destination` 是项目内 `exports/` 下的相对路径（不含本机绝对路径）；
 * `sha256` 是整个 ZIP 文件的摘要；`unresolvedAssets` 列出文档引用了但库里查不到的资源，
 * 这些缺口进入清单而不是被静默跳过。
 */
export const lessonExportResultSchema = z
  .object({
    projectId: z.string().min(1),
    lessonId: z.string().min(1),
    lessonVersion: z.number().int().positive(),
    format: z.enum(LESSON_EXPORT_FORMATS),
    /** 产物在项目内的相对路径。 */
    destination: z.string().min(1),
    fileName: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    manifest: lessonExportManifestSchema,
    /** 文档引用了但库中缺失的符号资源引用，逐条列出。 */
    unresolvedAssets: z.array(z.string().min(1)),
    message: z.string(),
  })
  .strict();
export type LessonExportResultDto = z.infer<typeof lessonExportResultSchema>;
