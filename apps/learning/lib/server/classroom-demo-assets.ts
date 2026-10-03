import { createHash } from 'node:crypto';
import { newId, StudyError } from '@sew/study-contracts';
import type { Session } from './service';
import { loadRenderableDocument } from './classroom-service';
import {
  DEMO_ASSET_MANIFEST,
  type DemoAssetManifestEntry,
} from '../classroom/demo-assets';
import {
  DEMO_ASSET_SCENE_ID,
  DEMO_ASSET_STAGE_ID,
  DEMO_FONT_REF,
  DEMO_FONT_SHA256,
  DEMO_FONT_SLOT,
  DEMO_IMAGE_REF,
  DEMO_IMAGE_SHA256,
  DEMO_IMAGE_SLOT,
} from '../classroom/demo-asset-refs';

export interface BoundDemoAsset {
  symbolicRef: string;
  assetId: string;
  mediaType: string;
  sha256: string;
}

const expectedSha = new Map<string, string>([
  [DEMO_IMAGE_REF, DEMO_IMAGE_SHA256],
  [DEMO_FONT_REF, DEMO_FONT_SHA256],
]);

const verifyStoredAsset = (entry: DemoAssetManifestEntry, row: NonNullable<ReturnType<Session['store']['getClassroomAsset']>>): void => {
  const byteHash = createHash('sha256').update(row.bytes).digest('hex');
  if (row.mediaType !== entry.mediaType || row.sha256 !== entry.sha256 || byteHash !== entry.sha256 ||
      !Buffer.from(row.bytes).equals(Buffer.from(entry.bytes))) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
      reason: 'demo_asset_integrity_mismatch',
      symbolicRef: entry.symbolicRef,
    });
  }
}

/** Persist exact reviewed demo bytes only from the explicit demo-import action. */
export const ensureReviewedDemoAssets = (session: Session, stageId: string): BoundDemoAsset[] => {
  if (stageId !== DEMO_ASSET_STAGE_ID) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'unexpected_demo_asset_stage', stageId });
  }
  return session.store.transaction(() => DEMO_ASSET_MANIFEST.map((entry) => {
    const slot = entry.symbolicRef === DEMO_IMAGE_REF ? DEMO_IMAGE_SLOT : DEMO_FONT_SLOT;
    const binding = session.store.getClassroomAssetBinding(
      session.projectId,
      stageId,
      DEMO_ASSET_SCENE_ID,
      slot,
    );
    if (binding) {
      if (binding.recordScope !== 'demo') {
        throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'demo_asset_scope_mismatch' });
      }
      const stored = session.store.getClassroomAsset(session.projectId, binding.assetId);
      if (!stored) {
        throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
          reason: 'demo_asset_binding_target_missing',
          symbolicRef: entry.symbolicRef,
        });
      }
      if (stored.recordScope !== 'demo') {
        throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'demo_asset_scope_mismatch' });
      }
      verifyStoredAsset(entry, stored);
      return { symbolicRef: entry.symbolicRef, assetId: binding.assetId, mediaType: entry.mediaType, sha256: entry.sha256 };
    }

    const assetId = newId<'asset'>('asset');
    session.store.putClassroomAsset(session.projectId, assetId, entry.mediaType, {
      filename: entry.filename,
      symbolicRef: entry.symbolicRef,
      reviewedDemo: true,
    }, entry.bytes, 'demo');
    const stored = session.store.getClassroomAsset(session.projectId, assetId);
    if (!stored) throw new StudyError('INTERNAL', { reason: 'demo_asset_write_readback_failed' });
    verifyStoredAsset(entry, stored);
    session.store.putClassroomAssetBinding(session.projectId, stageId, DEMO_ASSET_SCENE_ID, slot, assetId, 'demo');
    return { symbolicRef: entry.symbolicRef, assetId, mediaType: entry.mediaType, sha256: entry.sha256 };
  }));
};

/** Resolve symbolic refs only after the audited document and its source admission pass. */
export const getVerifiedDemoAssetBindings = (session: Session, stageId: string): BoundDemoAsset[] => {
  const renderable = loadRenderableDocument(session, stageId);
  if (!renderable) throw new StudyError('NOT_FOUND', { stageId });
  const bindings = session.store.listClassroomAssetBindings(session.projectId, stageId);
  const output = DEMO_ASSET_MANIFEST.map((entry) => {
    const slot = entry.symbolicRef === DEMO_IMAGE_REF ? DEMO_IMAGE_SLOT : DEMO_FONT_SLOT;
    const binding = bindings.find((item) => item.sceneId === DEMO_ASSET_SCENE_ID && item.slot === slot);
    if (!binding) {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
        reason: 'demo_asset_binding_missing',
        symbolicRef: entry.symbolicRef,
      });
    }
    if (binding.recordScope !== 'demo') {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'demo_asset_scope_mismatch' });
    }
    const stored = session.store.getClassroomAsset(session.projectId, binding.assetId);
    if (!stored) {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
        reason: 'demo_asset_binding_target_missing',
        symbolicRef: entry.symbolicRef,
      });
    }
    if (stored.recordScope !== 'demo') {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'demo_asset_scope_mismatch' });
    }
    verifyStoredAsset(entry, stored);
    if (expectedSha.get(entry.symbolicRef) !== stored.sha256) {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
        reason: 'demo_asset_manifest_digest_mismatch',
        symbolicRef: entry.symbolicRef,
      });
    }
    return { symbolicRef: entry.symbolicRef, assetId: binding.assetId, mediaType: entry.mediaType, sha256: entry.sha256 };
  });
  if (bindings.length !== DEMO_ASSET_MANIFEST.length) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'unexpected_demo_asset_bindings' });
  }
  return output;
};
