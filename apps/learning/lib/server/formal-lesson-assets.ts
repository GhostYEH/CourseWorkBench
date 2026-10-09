import { StudyError } from '@sew/study-contracts';
import type { Session } from './service';

interface ImageUse {
  sceneId: string;
  elementId: string;
  reference: string;
}
const imageUses = (document: unknown): ImageUse[] => {
  const scenes =
    (
      document as {
        scenes?: Array<{
          id: string;
          type: string;
          content?: { canvas?: { elements?: Array<{ id: string; type: string; src?: string }> } };
        }>;
      }
    )?.scenes ?? [];
  return scenes.flatMap((scene) =>
    scene.type !== 'slide'
      ? []
      : (scene.content?.canvas?.elements ?? []).flatMap((element) =>
          element.type === 'image'
            ? [{ sceneId: scene.id, elementId: element.id, reference: element.src ?? '' }]
            : [],
        ),
  );
};

/** Only an approved, intact media candidate from this lesson's frozen evidence may enter a formal slide. */
export const assertFormalLessonImage = (
  session: Session,
  reference: string,
  lessonId: string,
  bundleDigest: string,
) => {
  const asset = session.store.getClassroomAsset(session.projectId, reference);
  const taskId = asset?.metadata['generatedMediaTaskId'];
  const task =
    typeof taskId === 'string' ? session.store.media.byId(session.projectId, taskId) : null;
  if (
    !asset ||
    asset.recordScope !== 'formal' ||
    !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mediaType) ||
    !task ||
    task.command.kind !== 'image' ||
    task.review.status !== 'approved' ||
    task.command.lessonId !== lessonId ||
    task.bundleDigest !== bundleDigest ||
    asset.metadata['symbolicRef'] !== reference
  ) {
    throw new StudyError(
      'CLASSROOM_LESSON_NOT_REVIEWED',
      { reason: 'formal_image_approval_or_source_missing' },
      '图片必须来自本课程相同证据包的已审核媒体候选。',
    );
  }
  const product = session.store.media.readProduct(session.projectId, reference);
  if (!product || product.bytes.byteLength !== asset.bytes.byteLength)
    throw new StudyError('VERSION_CONFLICT', { reason: 'formal_image_product_changed' });
  return asset;
};

/**
 * 本课程相同证据包内**已审核图片**的符号引用集合（OMA-023 的资产准入）。
 *
 * 只有经媒体候选审核通过、属于同一课程与同一证据包的图片才能作为补丁里的 assetRef，
 * 与 `assertFormalLessonImage` 同源。服务端在补丁生成与保存两处都用它复验，避免 AI 或客户端
 * 把任意未审核资源当成正式图片写进课件。
 */
export const approvedFormalLessonImageRefs = (
  owner: Pick<Session, 'store' | 'projectId'>,
  lessonId: string,
  bundleDigest: string,
): Set<string> => {
  const refs = new Set<string>();
  for (const task of owner.store.media.list(owner.projectId)) {
    if (
      task.command.kind !== 'image' ||
      task.command.lessonId !== lessonId ||
      task.bundleDigest !== bundleDigest ||
      task.review.status !== 'approved'
    )
      continue;
    for (const product of task.products) {
      const asset = owner.store.getClassroomAsset(owner.projectId, product.assetId);
      if (
        asset &&
        asset.recordScope === 'formal' &&
        asset.metadata['symbolicRef'] === product.assetId
      )
        refs.add(product.assetId);
    }
  }
  return refs;
};

export const bindFormalLessonImages = (
  session: Session,
  stageId: string,
  document: unknown,
  lessonId: string,
  bundleDigest: string,
): void => {
  for (const use of imageUses(document)) {
    const asset = assertFormalLessonImage(session, use.reference, lessonId, bundleDigest);
    session.store.putClassroomAssetBinding(
      session.projectId,
      stageId,
      use.sceneId,
      `image:${use.elementId}`,
      asset.assetId,
      'formal',
    );
  }
};

export const readFormalLessonImages = (
  session: Session,
  stageId: string,
  document: unknown,
  lessonId: string,
  bundleDigest: string,
) => {
  const bindings = session.store.listClassroomAssetBindings(session.projectId, stageId);
  const assets = new Map<
    string,
    { symbolicRef: string; assetId: string; mediaType: string; sha256: string }
  >();
  for (const use of imageUses(document)) {
    const asset = assertFormalLessonImage(session, use.reference, lessonId, bundleDigest);
    if (
      !bindings.some(
        (binding) =>
          binding.recordScope === 'formal' &&
          binding.sceneId === use.sceneId &&
          binding.slot === `image:${use.elementId}` &&
          binding.assetId === asset.assetId,
      )
    )
      throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', {
        reason: 'formal_image_binding_missing',
      });
    assets.set(use.reference, {
      symbolicRef: use.reference,
      assetId: asset.assetId,
      mediaType: asset.mediaType,
      sha256: asset.sha256,
    });
  }
  return [...assets.values()];
};
