/**
 * 课件自包含导出包构建（OMA-068、OMA-069、OMA-070、OMA-072）。
 *
 * 输入是一份**已装配好的课堂文档**与其来源绑定；输出是一个 ZIP 包（条目按路径排序，
 * 时间戳取导出时刻，因此同一版本重复导出内容等价、字节不保证逐字相同）：
 * `manifest.json`（身份与逐条摘要）、`index.html`（可离线打开的静态课件）、
 * `assets/*`（文档引用到的、库中确实存在的图片/字体）。测验答案与判分依据在打包前
 * 被移除，因此分享产物不会泄露判分依据。
 *
 * 这一层不读应用层代码，也不做「能不能导出」的发布判断——那是服务入口的职责。
 * 它只负责：从权威存储取字节、稳定打包、如实登记缺口（引用不到的资源、未内联的
 * 客户端依赖），并把每个条目的字节数与 sha256 写进清单。
 */

import { createHash } from 'node:crypto';
import type {
  LessonExportManifest,
  LessonExportResourceDto,
  ScenePlanDto,
} from '@sew/study-contracts';
import { stripQuizAnswers, classroomDocumentDigest } from '@sew/study-domain';
import type { StudyStore } from './store';
import { writeZip } from './zip';

/** 导出包结构版本，与 contracts 的 LESSON_EXPORT_VERSION 保持一致。 */
const CONTAINER_VERSION = 1 as const;

const MAX_ASSETS = 500;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;
/** 与 contracts 的 `lessonExportManifestSchema.resources` 上限保持一致。 */
const MAX_RESOURCE_ENTRIES = 500;

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mediaExtension = (mediaType: string): string => {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'font/woff': 'woff',
    'font/woff2': 'woff2',
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    'application/json': 'json',
    'text/plain': 'txt',
  };
  return map[mediaType] ?? 'bin';
};

/** 文档场景的最小结构：只读取导出需要的字段，不依赖应用层类型。 */
interface DocumentScene {
  id: string;
  type: string;
  title: string;
  order: number;
  content?: Record<string, unknown>;
}

const readScenes = (document: unknown): DocumentScene[] => {
  const scenes = (document as { scenes?: unknown })?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes
    .filter(
      (scene): scene is Record<string, unknown> => Boolean(scene) && typeof scene === 'object',
    )
    .map((scene) => ({
      id: String(scene['id'] ?? ''),
      type: String(scene['type'] ?? ''),
      title: String(scene['title'] ?? ''),
      order: Number(scene['order'] ?? 0),
      content: (scene['content'] as Record<string, unknown> | undefined) ?? undefined,
    }))
    .filter((scene) => scene.id.length > 0)
    .sort((left, right) => left.order - right.order);
};

/** 收集幻灯片图片元素引用的符号资源；返回 assetRef → 是否出现在文档中。 */
const collectAssetRefs = (scenes: DocumentScene[]): Map<string, Set<string>> => {
  const refs = new Map<string, Set<string>>();
  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = scene.content?.['canvas'] as Record<string, unknown> | undefined;
    const elements = canvas?.['elements'];
    if (!Array.isArray(elements)) continue;
    for (const element of elements) {
      if (!element || typeof element !== 'object') continue;
      const record = element as Record<string, unknown>;
      if (record['type'] !== 'image') continue;
      const src = record['src'];
      if (typeof src === 'string' && src.length > 0 && !src.startsWith('data:')) {
        const sceneIds = refs.get(src) ?? new Set<string>();
        sceneIds.add(scene.id);
        refs.set(src, sceneIds);
      }
    }
  }
  return refs;
};

const renderSlide = (
  scene: DocumentScene,
  assetPaths: ReadonlyMap<string, string> = new Map(),
): string => {
  const canvas = scene.content?.['canvas'] as Record<string, unknown> | undefined;
  const size = Number(canvas?.['viewportSize'] ?? 1000);
  const ratio = Number(canvas?.['viewportRatio'] ?? 0.5625);
  const width = Number.isFinite(size) && size > 0 ? size : 1000;
  const height = Number.isFinite(ratio) && ratio > 0 ? width * ratio : width * 0.5625;
  const elements = Array.isArray(canvas?.['elements']) ? (canvas!['elements'] as unknown[]) : [];
  const parts = elements.map((element) => {
    if (!element || typeof element !== 'object') return '';
    const record = element as Record<string, unknown>;
    const style = `left:${Number(record['left'] ?? 0)}px;top:${Number(record['top'] ?? 0)}px;width:${Number(record['width'] ?? 0)}px;height:${Number(record['height'] ?? 0)}px;`;
    if (record['type'] === 'image') {
      const src = typeof record['src'] === 'string' ? record['src'] : '';
      const resolved = assetPaths.get(src);
      return resolved
        ? `<img class="el" style="${style}" src="${escapeHtml(resolved)}" alt="${escapeHtml(scene.title)}">`
        : `<div class="el el-missing" style="${style}">图片未随包内联：${escapeHtml(src || '（未指定）')}</div>`;
    }
    // content 为受控富文本（RICH_TEXT_TAGS 白名单 + 导出前已审核发布），此处不再二次转义，
    // 否则会把合法的 <sub>/<sup> 等标记显示成字面文本。
    const content = typeof record['content'] === 'string' ? record['content'] : '';
    return `<div class="el" style="${style}">${content}</div>`;
  });
  return `<section class="slide" data-scene="${escapeHtml(scene.id)}"><h2>${escapeHtml(scene.title)}</h2><div class="canvas-scroll"><div class="canvas" style="width:${width}px;height:${height}px">${parts.join('')}</div></div></section>`;
};

const renderQuiz = (scene: DocumentScene): string => {
  const questions = scene.content?.['questions'];
  const list = Array.isArray(questions) ? questions : [];
  const blocks = list.map((question) => {
    if (!question || typeof question !== 'object') return '';
    const record = question as Record<string, unknown>;
    const options = Array.isArray(record['options']) ? record['options'] : [];
    const optionList = options
      .map((option) => {
        if (!option || typeof option !== 'object') return '';
        const item = option as Record<string, unknown>;
        return `<li>${escapeHtml(String(item['label'] ?? item['value'] ?? ''))}</li>`;
      })
      .join('');
    return `<div class="question"><p>${escapeHtml(String(record['question'] ?? ''))}</p><ul class="options">${optionList}</ul></div>`;
  });
  return `<section class="quiz" data-scene="${escapeHtml(scene.id)}"><h2>${escapeHtml(scene.title)}</h2>${blocks.join('')}</section>`;
};

const renderInteractive = (scene: DocumentScene): string => {
  const html =
    typeof scene.content?.['html'] === 'string' ? (scene.content!['html'] as string) : '';
  return `<section class="interactive" data-scene="${escapeHtml(scene.id)}"><h2>${escapeHtml(scene.title)}</h2><iframe class="widget" sandbox="allow-scripts" title="${escapeHtml(scene.title)}" srcdoc="${escapeHtml(html)}"></iframe></section>`;
};

const renderPbl = (scene: DocumentScene): string => {
  const project = scene.content?.['projectV2'];
  if (
    typeof scene.content?.['definitionId'] !== 'string' ||
    scene.content['definitionId'].length === 0 ||
    !project ||
    typeof project !== 'object' ||
    Array.isArray(project)
  ) {
    return `<section class="pbl" data-scene="${escapeHtml(scene.id)}"><h2>${escapeHtml(scene.title)}</h2><p class="muted">这是历史 PBL 场景骨架，没有关联已冻结的公开项目定义。</p></section>`;
  }
  const definition = project as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const goals = Array.isArray(definition['gains']) ? definition['gains'] : [];
  const milestones = Array.isArray(definition['milestones']) ? definition['milestones'] : [];
  const goalList = goals.map((goal) => `<li>${escapeHtml(String(goal))}</li>`).join('');
  const milestoneList = milestones
    .map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
      const milestone = raw as Record<string, unknown>;
      const tasks = Array.isArray(milestone['microtasks']) ? milestone['microtasks'] : [];
      const taskList = tasks
        .map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
          const task = item as Record<string, unknown>;
          return `<li><strong>${escapeHtml(text(task['title']))}</strong>${text(task['description']) ? `：${escapeHtml(text(task['description']))}` : ''}</li>`;
        })
        .join('');
      return `<li><h4>${escapeHtml(text(milestone['title']))}</h4>${text(milestone['description']) ? `<p>${escapeHtml(text(milestone['description']))}</p>` : ''}<ul>${taskList}</ul></li>`;
    })
    .join('');
  return `<section class="pbl" data-scene="${escapeHtml(scene.id)}"><h2>${escapeHtml(text(definition['title']) || scene.title)}</h2><p>${escapeHtml(text(definition['description']))}</p>${text(definition['learningObjective']) ? `<h3>项目目标</h3><p>${escapeHtml(text(definition['learningObjective']))}</p>` : ''}${goalList ? `<h3>预期成果</h3><ul>${goalList}</ul>` : ''}${milestoneList ? `<h3>阶段与任务</h3><ol>${milestoneList}</ol>` : ''}</section>`;
};

const renderScene = (scene: DocumentScene): string => {
  if (scene.type === 'slide') return renderSlide(scene);
  if (scene.type === 'quiz') return renderQuiz(scene);
  if (scene.type === 'interactive') return renderInteractive(scene);
  return renderPbl(scene);
};

const STYLE = `
:root{color-scheme:light}
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;margin:0;background:#f4f6fb;color:#232323}
header.lesson{background:#1e3a8a;color:#fff;padding:16px 24px}
header.lesson h1{font-size:20px;margin:0 0 4px}
header.lesson p{margin:0;font-size:13px;opacity:.9}
main{padding:16px 24px;max-width:1100px;margin:0 auto}
section{background:#fff;border:1px solid #dde3ef;border-radius:10px;padding:16px;margin:16px 0}
section h2{font-size:16px;margin:0 0 12px}
.canvas-scroll{max-width:100%;overflow:auto}
.canvas{position:relative;background:#f4f6fb;border-radius:8px}
.el{position:absolute}
.el-missing{display:flex;align-items:center;justify-content:center;background:#fde;border:1px dashed #c66;font-size:13px;color:#933}
.widget{width:100%;height:360px;border:1px solid #dde3ef;border-radius:8px}
.options{list-style:none;padding-left:0}
.options li{padding:4px 0}
.muted{color:#6b7280;font-size:13px}
footer{padding:16px 24px;color:#6b7280;font-size:12px}
`;

export interface BuildLessonExportInput {
  store: StudyStore;
  projectId: string;
  lessonId: string;
  version: number;
  title: string;
  bundleDigest: string;
  plan: ScenePlanDto | null;
  stageId: string;
  dslVersion: string;
  /** 权威文档摘要（来自 classroom_documents.digest），不在导出层重算。 */
  documentDigest: string;
  /** 已装配的课堂文档（权威形状 `{ stage, scenes }`）。 */
  document: unknown;
}

export interface LessonExportPackage {
  fileName: string;
  bytes: Buffer;
  sha256: string;
  manifest: LessonExportManifest;
  unresolvedAssets: string[];
}

/**
 * 构建导出包。纯函数式地读取存储并打包，不写盘（落盘由调用方决定）。
 * 任何资源字节缺失都被记录为缺口，而不是让导出整体失败。
 */
export const buildLessonExport = (input: BuildLessonExportInput): LessonExportPackage => {
  const scenes = readScenes(input.document);
  // 分享产物不应含判分依据：先移除答案/解析/给分点，与课堂渲染同一口径。
  const stripped = stripQuizAnswers(input.document);
  const safeScenes = readScenes(stripped.document);

  const sources = input.store.listClassroomSceneSources(input.projectId, input.stageId);
  // 只解析当前课件场景的正式绑定；绑定资源不可替换，读取时复验字节摘要。
  // 全项目同名资源（包括新上传和演示资源）不得覆盖已审核的场景资源。
  const bindings = input.store.listClassroomAssetBindings(input.projectId, input.stageId);

  const unresolvedAssets: string[] = [];
  const resources: LessonExportResourceDto[] = [];
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const assetRefToPath = new Map<string, string>();
  let totalAssetBytes = 0;
  // 资源清单上限：内联图片 + 缺口条目 + 末尾固定缺口（katex/three.js）必须 ≤ 合同上限。
  const MAX_IMAGE_RESOURCES = MAX_RESOURCE_ENTRIES - 3;
  const recordResource = (resource: LessonExportResourceDto): void => {
    if (resources.length < MAX_IMAGE_RESOURCES) resources.push(resource);
    // 超限的图片条目不再进入清单（否则响应会违反合同 max），但仍保留在 unresolvedAssets 里。
  };

  for (const [ref, sceneIds] of collectAssetRefs(scenes)) {
    if (files.length >= MAX_ASSETS) {
      // 达到条目上限：既不内联也不静默丢弃，与其它缺口一样在 unresolvedAssets 与 resources 里登记。
      unresolvedAssets.push(ref);
      recordResource({
        kind: 'image',
        reference: ref,
        status: 'missing',
        note: '资源数量达到打包上限',
      });
      continue;
    }
    const candidates = [...sceneIds].map((sceneId) => {
      const matching = bindings
        .filter((binding) => binding.recordScope === 'formal' && binding.sceneId === sceneId)
        .map((binding) => input.store.getClassroomAsset(input.projectId, binding.assetId))
        .filter(
          (asset) => asset?.recordScope === 'formal' && asset.metadata['symbolicRef'] === ref,
        );
      const unique = new Map(matching.map((asset) => [asset!.assetId, asset!]));
      return unique.size === 1 ? [...unique.values()][0]! : null;
    });
    const first = candidates[0];
    const asset =
      first && candidates.every((candidate) => candidate?.assetId === first.assetId) ? first : null;
    if (!asset) {
      unresolvedAssets.push(ref);
      recordResource({
        kind: 'image',
        reference: ref,
        status: 'missing',
        note: '缺少唯一的正式场景资源绑定',
      });
      continue;
    }
    if (
      asset.bytes.byteLength > MAX_ASSET_BYTES ||
      totalAssetBytes + asset.bytes.byteLength > MAX_TOTAL_ASSET_BYTES
    ) {
      unresolvedAssets.push(ref);
      recordResource({
        kind: 'image',
        reference: ref,
        status: 'missing',
        note: '资源超出打包上限',
      });
      continue;
    }
    const path = `assets/asset-${files.length}.${mediaExtension(asset.mediaType)}`;
    assetRefToPath.set(ref, path);
    totalAssetBytes += asset.bytes.byteLength;
    files.push({ path, bytes: asset.bytes });
    recordResource({ kind: 'image', reference: path, status: 'inlined', note: '' });
  }

  // 让 index.html 里的图片引用指向包内路径：重渲染时按 assetRefToPath 解析。
  const renderSceneWithAssets = (scene: DocumentScene): string => {
    if (scene.type !== 'slide') return renderScene(scene);
    return renderSlide(scene, assetRefToPath);
  };

  // 已知的客户端依赖缺口：产物不引用外部 URL，因此这些依赖必须在清单里如实登记。
  resources.push({
    kind: 'formula',
    reference: 'katex',
    status: 'missing',
    note: '公式渲染依赖未随包内联，离线打开时公式样式可能缺失',
  });
  resources.push({
    kind: 'script',
    reference: 'three.js',
    status: 'missing',
    note: '3D 互动依赖未随包内联，相关互动在离线环境可能不可用',
  });
  if (safeScenes.some((scene) => scene.type === 'interactive')) {
    resources.push({
      kind: 'other',
      reference: 'formal-interaction',
      status: 'missing',
      note: '正式参数、关系与排序互动依赖课堂宿主，本静态导出不支持离线运行与提交',
    });
  }

  const sceneSections = safeScenes.map((scene, index) => {
    const source = sources.get(scene.id);
    const knowledge = source ? source.knowledgeIds.join('、') : '';
    const note = source
      ? `<p class="muted">来源审核：${escapeHtml(source.reviewedBy)} · 知识点 ${escapeHtml(knowledge || '（无）')}</p>`
      : '<p class="muted">该场景缺少来源绑定记录。</p>';
    return renderSceneWithAssets({ ...scene, order: index }) + note;
  });

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="lesson">
  <h1>${escapeHtml(input.title)}</h1>
  <p>课程 ${escapeHtml(input.lessonId)} · 版本 v${input.version} · ${scenes.length} 个场景 · 离线自包含导出</p>
</header>
<main>
${sceneSections.join('\n')}
</main>
<footer>
  <p>本产物为离线只读导出，测验答案与判分依据已移除；来源审核人见各场景下方。</p>
  <p>离线资源缺口：${
    resources
      .filter((resource) => resource.status === 'missing')
      .map((resource) => escapeHtml(resource.reference))
      .join('、') || '无'
  }。</p>
</footer>
</body>
</html>
`;

  files.push({ path: 'index.html', bytes: new TextEncoder().encode(html) });

  const entries = files
    .map((file) => ({
      path: file.path,
      byteLength: file.bytes.byteLength,
      sha256: sha256Of(file.bytes),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));

  const manifest: LessonExportManifest = {
    containerVersion: CONTAINER_VERSION,
    format: 'html',
    createdAt: new Date().toISOString(),
    projectId: input.projectId,
    lessonId: input.lessonId,
    lessonVersion: input.version,
    title: input.title,
    stageId: input.stageId,
    dslVersion: input.dslVersion,
    documentDigest: input.documentDigest,
    exportedDocumentDigest: classroomDocumentDigest(stripped.document),
    bundleDigest: input.bundleDigest,
    planDigest: input.plan?.digest ?? null,
    sceneCount: scenes.length,
    entries,
    resources,
  };

  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const archive = writeZip([...files, { path: 'manifest.json', bytes: manifestBytes }]);
  const safeLessonId = input.lessonId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60) || 'lesson';

  return {
    fileName: `lesson-${safeLessonId}-v${input.version}.zip`,
    bytes: archive,
    sha256: sha256Of(archive),
    manifest,
    unresolvedAssets,
  };
};
