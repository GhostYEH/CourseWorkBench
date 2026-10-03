import type { ReactNode } from 'react';
import { MaterialImportForm } from '../../../components/material-import-form';
import { Empty } from '../../../components/ui';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';
import { readWorkbenchMaterials } from '../../../lib/server/workbench-data';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ materialId?: string; segment?: string }>;
}

export default async function MaterialsPage({ searchParams }: PageProps): Promise<ReactNode> {
  const session = (getSession() ?? bootstrapFromEnvironment())!;
  const query = await searchParams;
  const materials = readWorkbenchMaterials(session);
  const active =
    materials.find((material) => material.materialId === query.materialId) ?? materials[0] ?? null;
  const segments = active ? session.store.getSegments(active.materialId, active.revision) : [];

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>材料与来源</h1>
          <p>
            列表显示材料名称、类型、版本、导入时间与状态。点击引用可以滚动并高亮对应段落；
            段落编号可复制，指纹可重算。
          </p>
        </div>
      </div>

      <MaterialImportForm projectId={session.projectId} generation={session.generation} />

      <div className="card">
        <h2>材料版本</h2>
        {materials.length === 0 ? (
          <Empty>还没有材料。导入考纲或教材节选，开始整理知识清单。</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>版本</th>
                <th>可读位置</th>
                <th>段落</th>
                <th>指纹</th>
                <th>导入时间</th>
                <th>被引用</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((material) => (
                <tr key={material.materialId}>
                  <td>{material.displayName}</td>
                  <td className="mono">{material.materialType}</td>
                  <td className="mono">r{material.revision}</td>
                  <td>{material.readableLocation ?? '—'}</td>
                  <td className="mono">{material.segmentCount}</td>
                  <td className="mono" title={material.fingerprint}>
                    {material.fingerprint.slice(0, 12)}…
                  </td>
                  <td className="muted mono">{material.importedAt.slice(0, 19).replace('T', ' ')}</td>
                  <td className="mono">{material.referencedByKnowledge} 项知识点</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {active ? (
        <div className="card">
          <h2>
            规范化原文 · {active.displayName} r{active.revision}
          </h2>
          <p className="muted">
            规范化版本 {active.normalizationVersion} · 全文指纹 {active.fingerprint.slice(0, 24)}…
            （查看完整校验信息可在审核面板展开）
          </p>
          {segments.map((segment) => (
            <div key={segment.segmentId}>
              <p className="muted mono">
                {segment.segmentId} · {segment.fingerprint.slice(0, 12)}…
              </p>
              <div className="excerpt" data-highlight={query.segment === segment.segmentId}>
                {segment.text}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
