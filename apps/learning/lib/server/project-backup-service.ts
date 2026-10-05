import { StudyError, type ProjectScope, type ProjectBackupResult } from '@sew/study-contracts';
import { createProjectBackup, restoreProjectBackup, ProjectBackupError } from '@sew/study-storage';
import { assertScope, getSession } from './service';
import { getLearnerProfile } from './learner-profile';

const execute = async (operation: () => Promise<ProjectBackupResult>) => {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ProjectBackupError)) throw error;
    const message =
      error.reason === 'uid_mismatch'
        ? '备份属于不同的个人 UID，已有身份与项目未被修改。'
        : error.reason === 'destination_exists'
          ? '目标目录已经存在，请选择一个尚不存在的新目录名称。'
          : error.reason === 'destination_in_open_project'
            ? '恢复目标位于当前打开的项目内，请选择项目目录之外的新位置。当前项目未被修改。'
            : error.reason === 'path_unavailable'
              ? '所选路径不存在或不可读取，请重新选择目录。未写入任何内容。'
              : '项目备份或恢复校验失败，未覆盖目标。请检查完整性、版本、目录权限与归属。';
    throw new StudyError(
      error.reason === 'uid_mismatch' ? 'PROJECT_NOT_AUTHORIZED' : 'INVALID_ARGUMENT',
      { reason: error.reason },
      message,
    );
  }
};

export const backupOpenedProject = (scope: ProjectScope, targetPath: string) => {
  const session = assertScope(scope);
  return execute(() =>
    createProjectBackup({
      store: session.store,
      projectRoot: session.displayPath,
      destinationRoot: targetPath,
      expectedUid: session.learnerUid,
    }),
  );
};

export const restoreBackupProject = (
  scope: ProjectScope | null,
  backupPath: string,
  targetPath: string,
) => {
  const active = getSession();
  if (scope) assertScope(scope);
  else if (active) throw new StudyError('PROJECT_GENERATION_STALE');
  return execute(() =>
    restoreProjectBackup({
      backupRoot: backupPath,
      destinationRoot: targetPath,
      expectedUid: getLearnerProfile().uid,
      // A restore must not publish a second project inside the one that is open right now.
      protectedRoots: active ? [active.displayPath] : [],
    }),
  );
};
