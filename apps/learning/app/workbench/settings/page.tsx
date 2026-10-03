import type { ReactNode } from 'react';
import { ProjectSettingsForm } from '../../../components/project-settings-form';
import { TeachingSettings } from '../../../components/appearance-settings';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';
import { readTeachingPreference } from '../../../lib/server/state';

export const dynamic = 'force-dynamic';

export default function SettingsPage(): ReactNode {
  const session = (getSession() ?? bootstrapFromEnvironment())!;
  const project = session.store.getProject(session.projectId)!;
  const teaching = readTeachingPreference(session);

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>科目设置</h1>
          <p>
            页面保存设置不代表候选或课程已经审核通过。未配置模型时可以先导入材料并整理项目；
            模型连接入口在底部任务栏与设置中就近可达。
          </p>
        </div>
      </div>

      <ProjectSettingsForm
        projectId={session.projectId}
        generation={session.generation}
        initial={{
          displayName: project.displayName,
          subject: project.subject,
          goal: project.goal,
          examDate: project.examDate,
          dailyMinutes: project.dailyMinutes,
          learningMode: project.learningMode,
        }}
      />

      <TeachingSettings initial={teaching} projectId={session.projectId} generation={session.generation} />

      <div className="card">
        <h2>模型连接</h2>
        <p className="secondary">
          密钥由 Electron 主进程加密保管，模型请求由本地服务执行；密钥不下发到页面、不进入项目备份。
          未配置模型时，课程生成、教师实时回复等入口明确显示不可用，不伪造进度。
        </p>
        <p className="muted">当前状态：未配置。</p>
      </div>
    </div>
  );
}
