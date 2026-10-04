import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import {
  StudyError, learnerProfileSchema, learnerProfileUpdateSchema,
  type LearnerProfileDto, type LearnerProfileUpdateInput,
} from '@sew/study-contracts';
import { resolveUserDataDir } from './global-preferences';

export const LEARNER_PROFILE_FILE_NAME = 'learner-profile.json';

const isFileError = (error: unknown, code: string): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code;

const identityFailure = (reason: string): StudyError => new StudyError(
  'INTERNAL', { reason }, '本地学习者身份读取或保存失败，已有身份未被重新生成，请检查用户数据目录',
);

/** The root is supplied by the trusted service, never by an HTTP body or project directory. */
export const createLearnerProfileStore = (root: string) => {
  const file = join(root, LEARNER_PROFILE_FILE_NAME);
  const lockFile = `${file}.lock`;

  const read = (): LearnerProfileDto | null => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (isFileError(error, 'ENOENT')) return null;
      throw identityFailure('identity_read_failed');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw identityFailure('identity_invalid_json');
    }
    const result = learnerProfileSchema.safeParse(decoded);
    if (!result.success) throw identityFailure('identity_invalid_schema');
    return result.data;
  };

  const writeTemporary = (profile: LearnerProfileDto): string => {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(profile)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return temporary;
    } catch {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original write failure. */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* A failed open may not create a file. */ }
      throw identityFailure('identity_write_failed');
    }
  };

  const get = (): LearnerProfileDto => {
    const current = read();
    if (current) return current;
    try { fs.mkdirSync(root, { recursive: true }); } catch { throw identityFailure('identity_directory_failed'); }
    const candidate = learnerProfileSchema.parse({
      schemaVersion: 1, uid: `uid_${randomUUID()}`, displayName: '本地学习者',
      revision: 1, createdAt: new Date().toISOString(), registrationStatus: 'local_only', canInvite: false,
    });
    const temporary = writeTemporary(candidate);
    try {
      // A hard link publishes the already-complete file atomically without replacing a competing creator.
      fs.linkSync(temporary, file);
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) throw identityFailure('identity_publish_failed');
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* An orphaned temporary file is never read as an identity. */ }
    }
    const persisted = read();
    if (!persisted) throw identityFailure('identity_publish_missing');
    return persisted;
  };

  const update = (input: LearnerProfileUpdateInput): LearnerProfileDto => {
    const parsed = learnerProfileUpdateSchema.safeParse(input);
    if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
    try { fs.mkdirSync(root, { recursive: true }); } catch { throw identityFailure('identity_directory_failed'); }
    let descriptor: number;
    try {
      // Cross-process mutual exclusion makes the identity/revision checks and replacement one write operation.
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
    } catch (error) {
      if (isFileError(error, 'EEXIST')) throw new StudyError(
        'VERSION_CONFLICT', { reason: 'identity_write_locked' },
        '学习者身份正在保存或上次保存尚未确认，请重新读取后重试；已有身份保持不变',
      );
      throw identityFailure('identity_lock_failed');
    }
    let temporary: string | undefined;
    try {
      const current = read();
      if (!current) throw new StudyError('VERSION_CONFLICT', { reason: 'identity_missing' });
      if (current.uid !== parsed.data.expectedUid || current.revision !== parsed.data.expectedRevision) throw new StudyError(
        'VERSION_CONFLICT', {
          reason: 'identity_precondition_failed', expectedRevision: parsed.data.expectedRevision, actualRevision: current.revision,
        },
      );
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw identityFailure('identity_revision_exhausted');
      const next = learnerProfileSchema.parse({
        ...current, displayName: parsed.data.displayName, revision: current.revision + 1,
      });
      temporary = writeTemporary(next);
      try { fs.renameSync(temporary, file); } catch { throw identityFailure('identity_replace_failed'); }
      temporary = undefined;
      return next;
    } finally {
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch { /* The old identity remains authoritative. */ }
      }
      try { fs.closeSync(descriptor); } finally {
        // Never recover or steal an existing lock automatically: a crashed writer needs local inspection.
        fs.unlinkSync(lockFile);
      }
    }
  };

  return { get, update };
};

/** Resolve on every request so a trusted service environment switch never reuses a cached profile. */
export const getLearnerProfile = (): LearnerProfileDto => createLearnerProfileStore(resolveUserDataDir()).get();
export const updateLearnerProfile = (input: LearnerProfileUpdateInput): LearnerProfileDto =>
  createLearnerProfileStore(resolveUserDataDir()).update(input);
