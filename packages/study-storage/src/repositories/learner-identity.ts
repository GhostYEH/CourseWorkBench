import { z } from 'zod';
import { LEGACY_LOCAL_LEARNER_KEY, StudyError, learnerUidSchema } from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';

const bindingSchema = z.object({
  projectId: z.string().min(1), learnerKey: z.literal(LEGACY_LOCAL_LEARNER_KEY), uid: learnerUidSchema,
  origin: z.enum(['created_local', 'legacy_local']), createdAt: z.string().datetime(),
}).strict();
export type LocalLearnerBinding = z.infer<typeof bindingSchema>;

/** Explains the existing single-user partition without rewriting its IDs or records. */
export class LearnerIdentityRepository {
  constructor(private readonly db: SqlDatabase) {}

  read(projectId: string): LocalLearnerBinding | null {
    const row = this.db.prepare('SELECT * FROM learner_identity_bindings WHERE project_id=?').get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const parsed = bindingSchema.safeParse({ projectId: row['project_id'], learnerKey: row['learner_key'], uid: row['learner_uid'], origin: row['origin'], createdAt: row['created_at'] });
    if (!parsed.success) throw new StudyError('INTERNAL', { reason: 'invalid_local_learner_binding' });
    return parsed.data;
  }

  bind(projectId: string, uid: string): LocalLearnerBinding {
    if (!learnerUidSchema.safeParse(uid).success) throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_learner_uid' });
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM projects WHERE project_id=?').get(projectId)) throw new StudyError('NOT_FOUND');
      const old = this.read(projectId);
      if (old) {
        if (old.uid !== uid) throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'project_learner_uid_mismatch' }, '这个项目已关联其他本地 UID。请使用原个人档案打开；跨设备身份恢复尚未接通。');
        return old;
      }
      const legacy = Boolean(this.db.prepare("SELECT 1 FROM attempts WHERE actor_type='human_learner' LIMIT 1").get()
        || this.db.prepare('SELECT 1 FROM classroom_runtime_sessions WHERE project_id=? AND learner_key=? LIMIT 1').get(projectId, LEGACY_LOCAL_LEARNER_KEY)
        || this.db.prepare('SELECT 1 FROM classroom_sessions WHERE project_id=? AND learner_key=? LIMIT 1').get(projectId, LEGACY_LOCAL_LEARNER_KEY)
        || this.db.prepare('SELECT 1 FROM classroom_kv WHERE project_id=? AND learner_key=? LIMIT 1').get(projectId, LEGACY_LOCAL_LEARNER_KEY));
      const binding: LocalLearnerBinding = { projectId, learnerKey: LEGACY_LOCAL_LEARNER_KEY, uid, origin: legacy ? 'legacy_local' : 'created_local', createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO learner_identity_bindings (project_id, learner_key, learner_uid, origin, created_at) VALUES (?,?,?,?,?)').run(binding.projectId, binding.learnerKey, binding.uid, binding.origin, binding.createdAt);
      return binding;
    });
  }
}
