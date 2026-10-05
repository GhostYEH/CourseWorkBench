'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import {
  MAX_EVALUATION_IMPORT_BYTES,
  evaluationReportSchema,
  frozenEvaluationSchema,
} from '@sew/study-contracts';
import type { EvaluationReport } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../../../lib/client';

const statusLabels = {
  empty: '无样本',
  not_run: '未运行',
  partial: '部分输出缺失',
  complete: '输出完整',
};
const metrics = [
  ['coverage', '原子考纲覆盖'],
  ['traceability', '机械来源追溯'],
  ['diagnosisExact', '可归因错因集合严格匹配'],
  ['abstention', '弃答'],
  ['unattributableRefusal', '不可归因拒绝'],
  ['forgedDetection', '已知伪装真题检出'],
  ['originalFalseBlock', '合法真原题误拦（含缺失输出）'],
  ['finalWrongIdentity', '最终错误身份（含缺失输出）'],
] as const;

export function EvalReportImportPanel({
  projectId,
  generation,
}: {
  projectId: string;
  generation: number;
}) {
  return (
    <ScopedEvalReportImportPanel
      key={`${projectId}:${generation}`}
      projectId={projectId}
      generation={generation}
    />
  );
}

function ScopedEvalReportImportPanel({
  projectId,
  generation,
}: {
  projectId: string;
  generation: number;
}) {
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => controller.current?.abort(), []);
  const importReport = async (file: File) => {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      if (file.size > MAX_EVALUATION_IMPORT_BYTES)
        throw new Error('评测包超过 2 MiB，请选择较小的冻结 JSON。');
      const text = await file.text();
      if (active.signal.aborted) return;
      const frozen = frozenEvaluationSchema.parse(JSON.parse(text));
      const body = JSON.stringify({ scope: { projectId, generation }, frozen });
      if (new Blob([body]).size > MAX_EVALUATION_IMPORT_BYTES)
        throw new Error('评测包请求超过 2 MiB。');
      const result = await apiFetch('/api/study/evaluation', evaluationReportSchema, {
        method: 'POST',
        body,
        signal: active.signal,
      });
      if (!active.signal.aborted) setReport(result);
    } catch (caught) {
      if (!active.signal.aborted) setError(describeApiError(caught));
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>导入报告并复验</h2>
      <p>
        选择冻结评测
        JSON，复验摘要并重算指标。仅展示该评测包的结果，不写入学习记录，也不代表本项目已完成真实验收。来源摘要能核对材料版本，不能证明语义支持或人工金标准的质量。
      </p>
      <label>
        冻结评测包（最多 2 MiB）{' '}
        <input
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importReport(file);
          }}
        />
      </label>
      {busy ? <p role="status">正在复验报告…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {report ? (
        <>
          <p>
            摘要与重算一致。数据集 {report.datasetId}；配置 {report.configId}。语义支持：未评测。
          </p>
          <p>
            成本：模型调用 {report.cost.modelCalls} 次；输入 / 输出 token{' '}
            {report.cost.inputTokens ?? '未知'} / {report.cost.outputTokens ?? '未知'}；金额{' '}
            {report.cost.monetaryCost ?? '未知'} {report.cost.currency ?? ''}；审核{' '}
            {report.cost.reviewItems} 项 / {report.cost.reviewSeconds} 秒。
          </p>
          {report.slices.map((slice) => (
            <details key={`${slice.provenance}:${slice.split}:${slice.stage}`}>
              <summary>
                {slice.provenance === 'real' ? '真实' : '合成'} /{' '}
                {slice.split === 'dev' ? '开发集' : slice.split === 'test' ? '测试集' : '攻击集'} /{' '}
                {slice.stage === 'before_review' ? '审核前' : '审核后'}：
                {statusLabels[slice.status]}，冻结 {slice.count} 项
              </summary>
              <table>
                <thead>
                  <tr>
                    <th>指标</th>
                    <th>分子 / 冻结分母</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map(([key, label]) => (
                    <tr key={key}>
                      <td>{label}</td>
                      <td>
                        {slice[key].numerator} / {slice[key].denominator}
                      </td>
                      <td>
                        {slice[key].rate === null
                          ? 'N/A（空分母）'
                          : `${(slice[key].rate * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                错因宏 F1：
                {slice.diagnosisMacroF1 === null
                  ? 'N/A（空分母）'
                  : slice.diagnosisMacroF1.toFixed(4)}
                。固定标签全集，不选择性删除零支持标签。
              </p>
              <p>
                缺失输出：{slice.missingOutputs.length ? slice.missingOutputs.join('、') : '无'}
                。未运行阶段的数值保留冻结分母，不作已完成评测解读。
              </p>
              <details>
                <summary>逐项失败（{slice.failures.length}）与混淆矩阵</summary>
                {slice.failures.length ? (
                  slice.failures.map((failure) => (
                    <div key={failure.caseId}>
                      <p>{failure.caseId}</p>
                      <pre>
                        {JSON.stringify(
                          { expected: failure.expected, actual: failure.actual },
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  ))
                ) : (
                  <p>无失败项。</p>
                )}
                <pre>
                  {JSON.stringify(
                    {
                      identityAndDecision: slice.confusion,
                      errorLabels: slice.errorLabelConfusion,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </details>
          ))}
        </>
      ) : null}
    </div>
  );
}
