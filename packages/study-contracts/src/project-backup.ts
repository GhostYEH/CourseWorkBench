import { z } from 'zod';
import { learnerUidSchema } from './learner-profile';

export const PROJECT_BACKUP_VERSION = 1;
/** Versioned directory container. Paths are portable relative POSIX paths. */
export const backupProjectManifestSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    projectId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(1000),
    createdAt: z.string().datetime(),
  })
  .strict();
export const projectBackupFileSchema = z
  .object({
    path: z.string().min(1).max(1024),
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 ** 3),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['manifest', 'database', 'source', 'asset', 'derived_export']),
  })
  .strict();
export const projectBackupManifestSchema = z
  .object({
    containerVersion: z.literal(PROJECT_BACKUP_VERSION),
    createdAt: z.string().datetime(),
    project: backupProjectManifestSchema,
    uid: learnerUidSchema,
    schemaVersion: z.number().int().positive(),
    dslVersions: z
      .object({ openmaic: z.string(), runtime: z.string(), formalInteraction: z.literal(1) })
      .strict(),
    files: z.array(projectBackupFileSchema).min(2).max(10000),
    externalReferences: z
      .array(
        z
          .object({
            materialId: z.string().min(1).max(200),
            revision: z.number().int().positive(),
            classification: z.enum(['archived_in_database', 'metadata_only']),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type ProjectBackupManifest = z.infer<typeof projectBackupManifestSchema>;
export type ProjectBackupFile = z.infer<typeof projectBackupFileSchema>;
export interface ProjectBackupResult {
  projectId: string;
  uid: string;
  destinationRoot: string;
  fileCount: number;
  byteLength: number;
}
