import type { ReactNode } from 'react';
import {
  MediaGenerationPanel,
  type MediaLessonOption,
} from '../../../components/media-generation-panel';
import { requireSession } from '../../../lib/server/service';
import { readMediaTasks } from '../../../lib/server/media-service';

export const dynamic = 'force-dynamic';

export default function MediaPage(): ReactNode {
  const session = requireSession();
  const lessons: MediaLessonOption[] = session.store
    .listLessons(session.projectId)
    .flatMap((lesson) => {
      const link = session.store.getLessonClassroomLink(lesson.lessonId, session.projectId);
      const version =
        link?.status === 'published'
          ? session.store.getLessonVersion(lesson.lessonId, link.lessonVersion, session.projectId)
          : null;
      if (!version) return [];
      const bundle = session.store.getEvidenceBundle(session.projectId, version.bundleId);
      return bundle
        ? [
            {
              lessonId: lesson.lessonId,
              title: version.title,
              statements: bundle.bundle.statements
                .filter((statement) => version.statementIds.includes(statement.statementId))
                .map((statement) => statement.text),
            },
          ]
        : [];
    });
  const audioAssets = session.store
    .listClassroomAssets(session.projectId)
    .filter(
      (asset) =>
        asset.recordScope === 'formal' && ['audio/wav', 'audio/mpeg'].includes(asset.mediaType),
    )
    .map((asset) => ({
      assetId: asset.assetId,
      mime: asset.mediaType,
      ...(typeof asset.metadata['durationSeconds'] === 'number'
        ? { seconds: asset.metadata['durationSeconds'] }
        : {}),
    }));
  return (
    <div className="page-wide">
      <div className="page-head">
        <h1>媒体与用量</h1>
      </div>
      <MediaGenerationPanel
        key={`${session.projectId}:${session.generation}`}
        projectId={session.projectId}
        generation={session.generation}
        lessons={lessons}
        audioAssets={audioAssets}
        initial={readMediaTasks(session)}
      />
    </div>
  );
}
