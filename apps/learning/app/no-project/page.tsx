import { Notice } from '../../components/ui';
import type { ReactNode } from 'react';
import { ProjectActions } from '../../components/project-actions';

export const dynamic = 'force-dynamic';

/** 没有已授权项目时的说明页：工作台不猜测路径，也不允许渲染层提交任意磁盘路径。 */
export default function NoProjectPage(): ReactNode {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>还没有打开项目</h1>
          <p>
            项目目录由桌面应用的原生选择器创建或打开，应用会为当前项目分配独立的数据空间。
          </p>
        </div>
      </div>
      <div className="card">
        <h2>选择一个项目</h2>
        <ProjectActions mode="choose" />
      </div>
      <Notice tone="pending">
        当前请求不属于任何已授权的打开项目，因此不会读写任何数据库。
      </Notice>
    </div>
  );
}
