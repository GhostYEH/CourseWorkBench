import Link from 'next/link';
import type { ReactNode } from 'react';
import { TeachingSettings } from '../../../components/appearance-settings';
import { AssetReclaim } from '../../../components/asset-reclaim';
import { ModelConnectionSettings } from '../../../components/model-connection-settings';
import { ModelUsagePanel } from '../../../components/model-usage-panel';
import { ProjectSettingsForm } from '../../../components/project-settings-form';
import { RoleProfiles } from '../../../components/role-profiles';
import { toRoleProfileDto } from '../../../lib/server/dto';
import { DEFAULT_MODEL_CALL_LIMITS } from '../../../lib/server/model-call';
import { requireSession } from '../../../lib/server/service';
import { readTeachingPreference } from '../../../lib/server/state';

export const dynamic = 'force-dynamic';

export default function SettingsPage(): ReactNode {
  const session = requireSession();
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
      <div className="card"><h2>个人档案</h2><p>个人 UID 和昵称跨科目保留。</p><Link className="btn" href="/profile">查看个人档案与 UID</Link></div>

      <TeachingSettings initial={teaching} projectId={session.projectId} generation={session.generation} />

      <ModelConnectionSettings />
      <ModelUsagePanel
        calls={session.store.listModelUsageCalls(session.projectId)}
        usage={session.store.getLatestRun() ? session.store.modelCallUsage(session.store.getLatestRun()!.runId) : { calls: 0, tokens: 0 }}
        report={session.store.getLatestRun()
          ? session.store.modelUsageReport(session.store.getLatestRun()!.runId, DEFAULT_MODEL_CALL_LIMITS)
          : null}
      />

      <RoleProfiles
        projectId={session.projectId}
        generation={session.generation}
        profiles={session.store.listRoleProfiles().map(toRoleProfileDto)}
        configDigest={session.store.roleConfigDigest()}
      />

      <AssetReclaim projectId={session.projectId} generation={session.generation} />
    </div>
  );
}
