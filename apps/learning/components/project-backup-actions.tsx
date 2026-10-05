'use client';

import { useState } from 'react';
import { useCommand } from '../lib/use-command';
import { Notice } from './ui';

export const ProjectBackupActions = ({
  scopeKey,
  canBackup = false,
}: {
  scopeKey: string;
  canBackup?: boolean;
}) => {
  const command = useCommand(scopeKey);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (action: 'backup' | 'restore') => {
    await command.run(
      async () => {
        const bridge = window.sewNative;
        if (!bridge) throw new Error('请在桌面应用中备份或恢复项目。');
        return action === 'backup' ? bridge.backupProject() : bridge.restoreProject();
      },
      {
        onStart: () => setMessage(null),
        onSuccess: (path) => {
          if (path)
            setMessage(
              action === 'backup'
                ? `项目备份已完成：${path}`
                : `已恢复到新目录：${path}。请使用“打开项目”选择该目录。`,
            );
        },
        onError: (caught) => {
          const error = caught instanceof Error ? caught.message : '';
          command.setError(
            error.includes('不同的个人 UID')
              ? '备份属于其他个人 UID，请使用原个人档案恢复。'
              : error.includes('目标目录已经存在')
                ? '目标目录已经存在，请选择尚不存在的新目录名称。'
                : error.includes('恢复目标位于当前打开的项目内')
                  ? '恢复目标位于当前打开的项目内，请选择项目目录之外的新位置；当前项目未被修改。'
                  : error.includes('所选路径不存在或不可读取')
                    ? '所选路径不存在或不可读取，请重新选择目录；未写入任何内容。'
                    : '备份或恢复失败，请检查备份完整性、版本、个人 UID 和目录权限；已有项目未被覆盖。',
          );
        },
      },
    );
  };
  return (
    <div className="card">
      <h2>项目备份与恢复</h2>
      <p className="secondary">
        备份包含项目清单、数据库、已归档原文和资产，并逐文件校验。外部材料路径只保留引用；尚未归档的文件不会被自动读取。恢复到新目录，保留原项目和当前个人
        UID。
      </p>
      <p className="muted">
        个人档案、模型密钥和应用会话不进入项目备份。跨设备恢复需要原个人身份；当前入口不迁移或重新绑定
        UID。
      </p>
      <div className="row-inline">
        {canBackup ? (
          <button
            type="button"
            className="btn"
            data-project-backup
            disabled={command.busy}
            onClick={() => void run('backup')}
          >
            备份当前项目
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          data-project-restore
          disabled={command.busy}
          onClick={() => void run('restore')}
        >
          {command.busy ? '处理中…' : '恢复项目备份'}
        </button>
      </div>
      {message ? (
        <Notice tone="verified" role="status">
          {message}
        </Notice>
      ) : null}
      {command.error ? (
        <Notice tone="error" role="alert">
          {command.error}
        </Notice>
      ) : null}
    </div>
  );
};
