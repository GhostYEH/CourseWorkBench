import type { ReactNode } from 'react';
import { ProjectSettingsForm } from '../../../components/project-settings-form';
import { TeachingSettings } from '../../../components/appearance-settings';
import { ModelConnectionSettings } from '../../../components/model-connection-settings';
import { AssetReclaim } from '../../../components/asset-reclaim';
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

      <ModelConnectionSettings />

      <AssetReclaim projectId={session.projectId} generation={session.generation} />
    </div>
  );
}
