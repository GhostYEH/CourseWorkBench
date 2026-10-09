import { createHash } from 'node:crypto';
import {
  StudyError,
  lessonExportResultSchema,
  type LessonExportResultDto,
  type PlanSceneDto,
  type LessonExportResourceDto,
} from '@sew/study-contracts';
import { buildPptxDeck, classroomDocumentDigest, type PptxMediaFact } from '@sew/study-domain';
import { readZip } from '@sew/study-storage';
import { assertScope, type Session } from './service';
import { loadRenderableFormalDocument } from './classroom-service';
import { serializeEditablePptx, type PptxBinaryAsset } from './pptx-serializer';
import { summarizePptxFormulaSupport } from './pptx-math';
import { assessPptxFontProvision, loadBundledPptxFont, type PptxFontProvision } from './pptx-fonts';
import { lessonExportFileName, publishLessonExport } from './lesson-export-files';

interface PublicScene {
  id: string;
  type: PlanSceneDto['kind'];
  title: string;
  content: unknown;
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const checkAbort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new StudyError('RUN_TERMINATED', { reason: 'export_cancelled' });
};

/** Export the frozen, public classroom projection; never ask a model to rewrite it. */
export async function exportPptxLesson(
  session: Session,
  lessonId: string,
  version: number,
  signal?: AbortSignal,
  provisionedFont?: PptxFontProvision,
): Promise<LessonExportResultDto> {
  checkAbort(signal);
  const ready = session.store.assertLessonClassroomReady(lessonId, session.projectId);
  if (ready.lesson.version !== version)
    throw new StudyError('VERSION_CONFLICT', { reason: 'export_lesson_version_not_published' });
  const renderable = loadRenderableFormalDocument(session, lessonId);
  if (!renderable)
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'export_document_missing' });
  const document = renderable.document as { scenes: PublicScene[] };
  const plan = session.store.getScenePlan(session.projectId, lessonId, version);
  const sources = session.store.listClassroomSceneSources(session.projectId, renderable.stageId);
  const scenes: PlanSceneDto[] =
    plan?.scenes ??
    document.scenes.map((scene) => {
      const source = sources.get(scene.id);
      return {
        sceneId: scene.id,
        kind: scene.type,
        title: scene.title,
        statementId: null,
        questionId: source?.questionId ?? null,
        knowledgeIds: source?.knowledgeIds ?? [],
        elements: [],
        note: '',
      };
    });
  if (
    scenes.length !== document.scenes.length ||
    scenes.some((scene, index) => scene.sceneId !== document.scenes[index]?.id)
  )
    throw new StudyError('VERSION_CONFLICT', { reason: 'pptx_document_scene_order_changed' });
  const media = new Map<string, PptxMediaFact>();
  const assets = new Map<string, PptxBinaryAsset>();
  const resources: LessonExportResourceDto[] = [];
  const refs = new Map<string, Set<string>>();
  for (const scene of document.scenes) {
    const canvas = (scene.content as { canvas?: { elements?: unknown[] } })?.canvas;
    for (const element of canvas?.elements ?? []) {
      const item = element as { type?: string; src?: string };
      if (item.type === 'image' && typeof item.src === 'string' && item.src) {
        const owners = refs.get(item.src) ?? new Set<string>();
        owners.add(scene.id);
        refs.set(item.src, owners);
      }
    }
  }
  const bindings = session.store.listClassroomAssetBindings(session.projectId, renderable.stageId);
  for (const [ref, owners] of refs) {
    const resolved = [...owners].map((sceneId) => {
      const matching = bindings
        .filter((binding) => binding.recordScope === 'formal' && binding.sceneId === sceneId)
        .map((binding) => session.store.getClassroomAsset(session.projectId, binding.assetId))
        .filter(
          (asset) => asset?.recordScope === 'formal' && asset.metadata['symbolicRef'] === ref,
        );
      const unique = new Map(matching.map((asset) => [asset!.assetId, asset!]));
      return unique.size === 1 ? [...unique.values()][0]! : null;
    });
    const first = resolved[0];
    const asset = first && resolved.every((item) => item?.assetId === first.assetId) ? first : null;
    if (!asset || !['image/png', 'image/jpeg', 'image/gif'].includes(asset.mediaType)) {
      resources.push({
        kind: 'image',
        reference: `image-${resources.length + 1}`,
        status: 'missing',
        note: '缺少唯一正式绑定，或图片格式不支持 PowerPoint 内联。',
      });
      continue;
    }
    if (hash(asset.bytes) !== asset.sha256)
      throw new StudyError('INTERNAL', { reason: 'pptx_asset_bytes_changed' });
    // Generated media has an independent on-disk receipt; validate it before embedding.
    if (asset.metadata['generatedMediaTaskId'])
      session.store.media.readProduct(session.projectId, asset.assetId);
    const extension =
      asset.mediaType === 'image/png' ? 'png' : asset.mediaType === 'image/gif' ? 'gif' : 'jpg';
    const reference = `assets/image-${assets.size + 1}.${extension}`;
    assets.set(reference, { bytes: asset.bytes, mime: asset.mediaType });
    media.set(ref, {
      reference,
      mediaType: asset.mediaType,
      sha256: asset.sha256,
      byteLength: asset.bytes.byteLength,
    });
    resources.push({ kind: 'image', reference, status: 'inlined', note: '' });
  }
  const fontCandidate = provisionedFont ?? loadBundledPptxFont();
  const fontAssessment = assessPptxFontProvision(fontCandidate, fontCandidate?.typeface ?? '');
  const fontProvision = fontAssessment.embeddable ? fontCandidate : null;
  const deck = buildPptxDeck({
    identity: {
      projectId: session.projectId,
      lessonId,
      lessonVersion: version,
      bundleId: ready.lesson.bundleId,
      title: ready.lesson.title,
      stageId: renderable.stageId,
      dslVersion: renderable.dslVersion,
      documentDigest: renderable.digest,
      exportedDocumentDigest: classroomDocumentDigest(renderable.document),
      planDigest: plan?.digest ?? null,
    },
    scenes,
    options: {
      media,
      ...(fontProvision ? { theme: { fontName: fontProvision.typeface } } : {}),
      documentSceneContent: new Map(document.scenes.map((scene) => [scene.id, scene.content])),
      generatedAt: new Date().toISOString(),
    },
  });
  const formulaSupport = summarizePptxFormulaSupport(deck);
  if (
    formulaSupport.converted +
      formulaSupport.unsupported +
      formulaSupport.convertedInline +
      formulaSupport.unsupportedInline >
    0
  )
    resources.push({
      kind: 'formula',
      reference: 'office-native-math',
      status:
        formulaSupport.unsupported === 0 && formulaSupport.unsupportedInline === 0
          ? 'inlined'
          : 'missing',
      note:
        formulaSupport.unsupported === 0 && formulaSupport.unsupportedInline === 0
          ? `已转换 ${formulaSupport.converted + formulaSupport.convertedInline} 个 LaTeX 公式为可编辑 PowerPoint Office Math 对象。`
          : `已转换 ${formulaSupport.converted + formulaSupport.convertedInline} 个公式；${formulaSupport.unsupported + formulaSupport.unsupportedInline} 个复杂或无效公式仍为可编辑源码文本，未作为数学事实转换。`,
    });
  for (const issue of deck.issues) {
    if (issue.code === 'unconverted-scene' || issue.code === 'quiz-scene-degraded')
      resources.push({
        kind: 'other',
        reference: issue.sceneId,
        status: 'missing',
        note: issue.reason,
      });
  }
  const bytes = await serializeEditablePptx(deck, assets, fontProvision);
  if (fontProvision && deck.theme.fontName === fontProvision.typeface) {
    resources.push({
      kind: 'font',
      reference: `${fontProvision.typeface}/regular`,
      status: 'inlined',
      note: `已嵌入 ${fontProvision.typeface} Regular（${fontProvision.sha256}）；Bold/Italic 字面未配置独立字体文件。`,
    });
    const hasBold = deck.slides.some((slide) =>
      slide.shapes.some(
        (shape) =>
          shape.kind === 'text' &&
          shape.runs.some((run) => run.fontName === fontProvision.typeface && run.bold),
      ),
    );
    const hasItalic = deck.slides.some((slide) =>
      slide.shapes.some(
        (shape) =>
          shape.kind === 'text' &&
          shape.runs.some((run) => run.fontName === fontProvision.typeface && run.italic),
      ),
    );
    if (hasBold)
      resources.push({
        kind: 'font',
        reference: `${fontProvision.typeface}/bold`,
        status: 'missing',
        note: '仅 Regular 字体面已授权嵌入；未配置真实 Bold 文件。',
      });
    if (hasItalic)
      resources.push({
        kind: 'font',
        reference: `${fontProvision.typeface}/italic`,
        status: 'missing',
        note: '仅 Regular 字体面已授权嵌入；未配置真实 Italic 文件。',
      });
  } else {
    resources.push({
      kind: 'font',
      reference: fontCandidate?.typeface ?? 'system-font',
      status: 'missing',
      note: fontCandidate
        ? fontAssessment.reason === 'font_license_restricts_editing'
          ? '字体 fsType 不允许可编辑嵌入；未写入字体数据。'
          : '所选字体没有通过许可或族名校验，未嵌入。'
        : '未找到受控的已授权字体文件；目标设备需提供系统字体。',
    });
  }
  if (formulaSupport.converted + formulaSupport.convertedInline > 0)
    resources.push({
      kind: 'font',
      reference: 'Office Math default font',
      status: 'missing',
      note: '原生 Office Math 对象使用目标 PowerPoint 的数学字体；本包未包含未授权的系统数学字体。',
    });
  checkAbort(signal);
  assertScope({ projectId: session.projectId, generation: session.generation });
  // Serialization yields: withdrawal, changed sources or project switching must stop publication.
  const current = session.store.assertLessonClassroomReady(lessonId, session.projectId);
  const currentDocument = loadRenderableFormalDocument(session, lessonId);
  const currentPlan = session.store.getScenePlan(session.projectId, lessonId, version);
  if (
    current.lesson.version !== version ||
    current.lesson.bundleDigest !== ready.lesson.bundleDigest ||
    currentDocument?.digest !== renderable.digest ||
    (currentPlan?.digest ?? null) !== (plan?.digest ?? null)
  )
    throw new StudyError('VERSION_CONFLICT', { reason: 'pptx_source_changed_during_export' });
  const entries = readZip(bytes, { allowEmptyDirectories: true })
    .map((part) => ({
      path: part.path,
      byteLength: part.bytes.byteLength,
      sha256: hash(part.bytes),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const fileName = lessonExportFileName(lessonId, version, 'pptx');
  const result = lessonExportResultSchema.parse({
    projectId: session.projectId,
    lessonId,
    lessonVersion: version,
    format: 'pptx',
    destination: `exports/${fileName}`,
    fileName,
    byteLength: bytes.byteLength,
    sha256: hash(bytes),
    manifest: {
      containerVersion: 1,
      format: 'pptx',
      createdAt: deck.generatedAt,
      projectId: session.projectId,
      lessonId,
      lessonVersion: version,
      title: ready.lesson.title,
      stageId: renderable.stageId,
      dslVersion: renderable.dslVersion,
      documentDigest: renderable.digest,
      exportedDocumentDigest: deck.identity.exportedDocumentDigest,
      bundleDigest: ready.lesson.bundleDigest,
      planDigest: plan?.digest ?? null,
      sceneCount: deck.slides.length,
      entries,
      resources,
    },
    unresolvedAssets: [...refs.keys()]
      .filter((ref) => !media.has(ref))
      .map((_ref, index) => `image-${index + 1}`),
    message: '已保存可编辑 PowerPoint；格式转换和离线运行缺口见清单。',
  });
  publishLessonExport(session.displayPath, fileName, bytes);
  return result;
}
