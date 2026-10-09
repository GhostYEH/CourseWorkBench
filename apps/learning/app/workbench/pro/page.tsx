import type { ReactNode } from 'react';
import Link from 'next/link';
import { ProSessionPanel } from '../../../components/pro-session-panel';
import { ProExternalTokens } from '../../../components/pro-external-tokens';
import { ProClassroomMount } from '../../../components/pro-classroom-mount';
import { assertScope, requireSession } from '../../../lib/server/service';

export const dynamic = 'force-dynamic';

export default async function ProWorkbenchPage({
  searchParams,
}: {
  searchParams?: Promise<{ lesson?: string }>;
}): Promise<ReactNode> {
  const session = requireSession();
  assertScope({ projectId: session.projectId, generation: session.generation });
  const lessonParam = (await searchParams)?.lesson;
  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>Pro 助手</h1>
          <p>本机项目范围内的持久对话、固定技能参考和需本人确认的受控工具。</p>
        </div>
      </div>
      <p className="muted">
        此页面走本地同源接口；项目 ID
        只用于定位当前已打开项目，不是身份凭据。对话需要当前学习计划、冻结证据包与模型准入均有效。
      </p>
      <ProSessionPanel scope={{ projectId: session.projectId, generation: session.generation }} />
      <section className="card">
        <h2>真实课堂（OMA-011）</h2>
        <p className="muted">
          这里直接挂载与课堂页相同的真实渲染面（上游 Stage / PlaybackEngine），不是预览图。
          只挂载已发布且有课件文档的版本。
        </p>
        <ProClassroomMount session={session} {...(lessonParam ? { lessonId: lessonParam } : {})} />
      </section>
      <ProExternalTokens scope={{ projectId: session.projectId, generation: session.generation }} />
      <p>
        <Link href="/workbench/lessons">课程与课件候选审核</Link>
      </p>
    </div>
  );
}
