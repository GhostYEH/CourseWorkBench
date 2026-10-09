import { Notice } from '../../components/ui';
import type { ReactNode } from 'react';
import { ProjectActions } from '../../components/project-actions';
import { ProjectBackupActions } from '../../components/project-backup-actions';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/** 没有已授权项目时的说明页：工作台不猜测路径，也不允许渲染层提交任意磁盘路径。 */
export default async function NoProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ recovery?: string }>;
}): Promise<ReactNode> {
  const recovery = (await searchParams).recovery === '1';
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>选择学习空间</h1>
          <p>
            {recovery ? (
              '上次的学习空间暂时无法读取，可能需要更新应用或恢复备份。原有数据已保留，请选择其他空间或恢复备份。'
            ) : (
              <>
                你已退出当前学习空间。可以导入已有备考数据，或为另一门科目添加独立空间。桌面应用再次启动会自动恢复学习空间。
              </>
            )}
          </p>
        </div>
      </div>
      <div className="card">
        <h2>继续你的备考</h2>
        <ProjectActions mode="choose" />
        <p>
          <Link href="/profile">查看个人档案与 UID</Link>
        </p>
      </div>
      <Notice tone="pending">材料、课程和练习按学习空间分别保存。切换空间不会删除原有数据。</Notice>
      <ProjectBackupActions scopeKey="no-project" />
    </div>
  );
}
