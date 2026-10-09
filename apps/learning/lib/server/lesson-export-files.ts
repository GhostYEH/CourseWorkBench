import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { StudyError, type LessonExportFormat } from '@sew/study-contracts';
import type { Session } from './service';

export const lessonExportFileName = (
  lessonId: string,
  version: number,
  format: LessonExportFormat,
): string => {
  const safe = lessonId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60) || 'lesson';
  return `lesson-${safe}-v${version}.${format === 'html' ? 'zip' : format}`;
};

const exportDirectory = (root: string): string => {
  const actualRoot = realpathSync(root);
  const directory = join(actualRoot, 'exports');
  mkdirSync(directory, { recursive: true });
  const actual = realpathSync(directory);
  const child = relative(actualRoot, actual);
  if (
    lstatSync(directory).isSymbolicLink() ||
    child !== 'exports' ||
    child.split(sep).includes('..')
  ) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'export_directory_outside_project' });
  }
  return actual;
};

export const publishLessonExport = (root: string, fileName: string, bytes: Uint8Array): void => {
  if (!/^lesson-[a-z0-9_-]+-v[1-9]\d*\.(pptx|zip|mp4)$/i.test(fileName))
    throw new StudyError('INVALID_ARGUMENT');
  const destination = join(exportDirectory(root), fileName);
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, destination);
  } catch {
    rmSync(temporary, { force: true });
    throw new StudyError(
      'INTERNAL',
      { reason: 'export_write_failed' },
      '导出文件写入失败，请检查项目目录权限与磁盘空间。',
    );
  }
};

/** Filename is derived from a published lesson; no renderer-selected disk paths. */
export const readLessonExport = (
  session: Session,
  lessonId: string,
  version: number,
  format: LessonExportFormat,
  sha256: string,
): { bytes: Uint8Array; fileName: string; mime: string } => {
  const ready = session.store.assertLessonClassroomReady(lessonId, session.projectId);
  if (ready.lesson.version !== version) throw new StudyError('VERSION_CONFLICT');
  const fileName = lessonExportFileName(lessonId, version, format);
  const file = join(exportDirectory(session.displayPath), fileName);
  let bytes: Uint8Array;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024)
      throw new Error('invalid-file');
    bytes = readFileSync(file);
  } catch {
    throw new StudyError('NOT_FOUND', { reason: 'export_file_missing_or_invalid' });
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new StudyError('VERSION_CONFLICT', { reason: 'export_file_digest_changed' });
  return {
    bytes,
    fileName,
    mime:
      format === 'pptx'
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : format === 'mp4'
          ? 'video/mp4'
          : 'application/zip',
  };
};
