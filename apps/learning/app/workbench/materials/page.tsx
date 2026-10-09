import Link from 'next/link';
import type { ReactNode } from 'react';
import { ExamSourceVerification } from '../../../components/exam-source-verification';
import { MaterialImportForm } from '../../../components/material-import-form';
import { MaterialOriginal } from '../../../components/material-original';
import { MaterialBinaryOriginal } from '../../../components/material-binary-original';
import { Empty } from '../../../components/ui';
import { toMaterialDto } from '../../../lib/server/dto';
import { assertScope, requireSession } from '../../../lib/server/service';
import { readWorkbenchMaterials } from '../../../lib/server/workbench-data';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ materialId?: string; revision?: string; segment?: string }>;
}

const sourceHref = (materialId: string, revision: number, segment?: string): string => {
  const query = new URLSearchParams({ materialId, revision: String(revision) });
  if (segment) query.set('segment', segment);
  return `/workbench/materials?${query}${segment ? `#source-${encodeURIComponent(segment)}` : ''}`;
};

export default async function MaterialsPage({ searchParams }: PageProps): Promise<ReactNode> {
  const session = requireSession();
  const query = await searchParams;
  assertScope({ projectId: session.projectId, generation: session.generation });
  const materials = readWorkbenchMaterials(session);
  const revision = query.revision === undefined ? undefined : Number(query.revision);
  const invalidRevision =
    query.revision !== undefined &&
    (!/^[1-9]\d*$/.test(query.revision) || !Number.isSafeInteger(revision) || !query.materialId);
  const active = invalidRevision
    ? null
    : query.materialId
      ? session.store.getMaterial(query.materialId, revision)
      : (materials[0] ?? null);
  const versions = active ? session.store.listMaterialVersions(active.materialId) : [];
  const segments = active ? session.store.getSegments(active.materialId, active.revision) : [];
  const binaryOriginal = active
    ? (session.store.readMaterialExtractionOriginal(active.materialId, active.revision)?.receipt ??
      null)
    : null;

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>材料与来源</h1>
          <p>
            列表显示最新版本，打开材料后可以查看不可变历史版本。来源链接固定材料版本与段落；
            由本机文件导入的材料还保存了原始文件字节，可以按段落定位并打开原文。
          </p>
        </div>
      </div>

      <div className="workflow-guide">
        <h2>从你的教材开始</h2>
        <p>
          导入材料后，<Link href="/workbench/knowledge?tab=candidates">整理知识点</Link>，再
          <Link href="/workbench/review">对照原文核对</Link>。确认的知识点会用于备考计划和课程。
        </p>
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
                  <td>
                    <Link href={sourceHref(material.materialId, material.revision)}>
                      {material.displayName}
                    </Link>
                  </td>
                  <td className="mono">{material.materialType}</td>
                  <td className="mono">r{material.revision}</td>
                  <td>{material.readableLocation ?? '—'}</td>
                  <td className="mono">{material.segmentCount}</td>
                  <td className="mono" title={material.fingerprint}>
                    {material.fingerprint.slice(0, 12)}…
                  </td>
                  <td className="muted mono">
                    {material.importedAt.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="mono">{material.referencedByKnowledge} 项知识点</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {invalidRevision || (query.materialId && !active) ? (
        <div className="card">
          <Empty>指定的材料版本不存在或版本参数无效，请从材料列表重新选择。</Empty>
        </div>
      ) : null}

      {active ? (
        <div className="card">
          <nav className="row-inline" aria-label="材料历史版本">
            {versions.map((version) => (
              <Link
                key={version.revision}
                href={sourceHref(version.materialId, version.revision)}
                aria-current={version.revision === active.revision ? 'page' : undefined}
              >
                r{version.revision}
                {version.revision === versions[0]?.revision ? '（最新）' : '（历史）'}
              </Link>
            ))}
          </nav>
          <h2 data-source-version={active.revision}>
            保存的规范化段落 · {active.displayName} r{active.revision}
          </h2>
          <p className="muted">
            规范化版本 {active.normalizationVersion} · 全文指纹{' '}
            <span className="mono" style={{ overflowWrap: 'anywhere' }}>
              {active.fingerprint}
            </span>
            。
            {active.rawArchive.state === 'archived'
              ? ` 原始文件已归档：${active.rawArchive.originalName ?? '未登记文件名'} · ${active.rawArchive.byteLength} 字节 · SHA-256 ${active.rawArchive.sha256.slice(0, 12)}…；下方段落与归档原文同属一个版本。`
              : active.rawArchive.reason === 'text_import'
                ? ' 原始文件未归档：该版本由粘贴导入，只保存了规范化段落，不能按原文打开。'
                : ' 原始文件未归档：该版本在归档功能之前导入，只保存了规范化段落；重新导入同一文件即可归档原文。'}
          </p>
          {query.segment && !segments.some((segment) => segment.segmentId === query.segment) ? (
            <Empty>指定段落不属于当前材料版本，请检查来源链接。</Empty>
          ) : null}
          <MaterialOriginal
            key={`${active.materialId}-r${active.revision}-${query.segment ?? 'all'}`}
            projectId={session.projectId}
            generation={session.generation}
            materialId={active.materialId}
            revision={active.revision}
            segmentId={query.segment}
          />
          {binaryOriginal ? (
            <MaterialBinaryOriginal
              key={`${active.materialId}:${active.revision}`}
              projectId={session.projectId}
              generation={session.generation}
              receipt={binaryOriginal}
            />
          ) : null}
          <ExamSourceVerification
            key={`${active.materialId}-r${active.revision}-exam`}
            projectId={session.projectId}
            generation={session.generation}
            material={toMaterialDto(active)}
          />
          {segments.map((segment) => (
            <div
              key={segment.segmentId}
              id={`source-${segment.segmentId}`}
              style={{ scrollMarginTop: 'var(--sew-space-6)' }}
            >
              <p className="muted mono">
                <Link href={sourceHref(active.materialId, active.revision, segment.segmentId)}>
                  {segment.segmentId}
                </Link>
                {' · '}
                <span title={segment.fingerprint}>{segment.fingerprint.slice(0, 12)}…</span>
                {segment.rawLineStart !== null && segment.rawLineEnd !== null
                  ? ` · 原文第 ${segment.rawLineStart}–${segment.rawLineEnd} 行`
                  : ''}
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
