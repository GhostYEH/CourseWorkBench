'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formalInteractionStateSchema, type FormalInteractionStateDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../../lib/client';
import { restoreOrderingOrder } from '../../lib/formal-ordering';

function FormalInteractiveSceneContent({
  stageId,
  sceneId,
  scope,
}: {
  stageId: string;
  sceneId: string;
  scope: { projectId: string; generation: number };
}) {
  const [state, setState] = useState<FormalInteractionStateDto | null>(null);
  const [a, setA] = useState('0');
  const [x, setX] = useState('1');
  /** 本人预测：必须与解释分开保存，且在提交前给出。 */
  const [prediction, setPrediction] = useState('');
  const [edgeId, setEdgeId] = useState('');
  const [to, setTo] = useState('');
  /** 本人给出的排序（`ordering` 定义）；服务端核验是否与冻结的正确顺序一致。 */
  const [order, setOrder] = useState<string[]>([]);
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epochRef = useRef(0);
  const busyRef = useRef(false);
  const requestRef = useRef<{ digest: string; nonce: string } | null>(null);
  const requests = useRef(new Set<AbortController>());
  const readVersion = useRef(0);
  const headers = {
    'x-sew-project-id': scope.projectId,
    'x-sew-generation': String(scope.generation),
  };
  const load = useCallback(
    async (epoch: number) => {
      const controller = new AbortController();
      requests.current.add(controller);
      const version = ++readVersion.current;
      try {
        const loaded = await apiFetch(
          `/api/study/formal-interactions?stageId=${encodeURIComponent(stageId)}&sceneId=${encodeURIComponent(sceneId)}`,
          formalInteractionStateSchema,
          {
            headers: {
              'x-sew-project-id': scope.projectId,
              'x-sew-generation': String(scope.generation),
            },
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (
          controller.signal.aborted ||
          epoch !== epochRef.current ||
          version !== readVersion.current
        )
          return;
        setState(loaded);
        setError(null);
        const latest =
          loaded.draft &&
          (!loaded.lastSubmission || loaded.draft.createdAt > loaded.lastSubmission.createdAt)
            ? loaded.draft
            : loaded.lastSubmission;
        const values = latest?.payload.values;
        setExplanation(values?.explanation ?? '');
        if (loaded.definition.kind === 'parameter') {
          setA(String(values?.kind === 'parameter' ? values.a : loaded.definition.min));
          setX(String(values?.kind === 'parameter' ? values.x : 1));
          const saved = values?.kind === 'parameter' ? values.prediction : null;
          setPrediction(saved === null || saved === undefined ? '' : String(saved));
        } else if (loaded.definition.kind === 'concept_relation') {
          setEdgeId(
            values?.kind === 'concept_relation'
              ? values.edgeId
              : (loaded.definition.edges[0]?.id ?? ''),
          );
          setTo(
            values?.kind === 'concept_relation'
              ? values.to
              : (loaded.definition.nodes[0]?.id ?? ''),
          );
        } else {
          // 只恢复本人已给出的排列，候选呈现顺序不自动成为本人答案。
          const saved = values?.kind === 'ordering' ? values.order : null;
          setOrder(restoreOrderingOrder(saved));
        }
      } catch (caught) {
        if (
          !controller.signal.aborted &&
          epoch === epochRef.current &&
          version === readVersion.current
        )
          setError(describeApiError(caught));
      } finally {
        requests.current.delete(controller);
      }
    },
    [stageId, sceneId, scope.projectId, scope.generation],
  );
  useEffect(() => {
    const owner = epochRef;
    const epoch = ++owner.current;
    const controllers = requests.current;
    setState(null);
    setError(null);
    busyRef.current = false;
    setBusy(false);
    void load(epoch);
    return () => {
      if (epoch === owner.current) owner.current++;
      controllers.forEach((controller) => controller.abort());
    };
  }, [load]);
  const save = async (operation: 'draft' | 'submit') => {
    if (!state || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const epoch = epochRef.current;
    readVersion.current += 1;
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const current = state.definition;
      const values =
        current.kind === 'parameter'
          ? {
              kind: 'parameter' as const,
              a: Number(a),
              x: Number(x),
              prediction: prediction.trim() === '' ? null : Number(prediction),
              explanation,
            }
          : current.kind === 'concept_relation'
            ? { kind: 'concept_relation' as const, edgeId, to, explanation }
            : { kind: 'ordering' as const, order, explanation };
      if (
        current.kind === 'ordering' &&
        values.kind === 'ordering' &&
        values.order.length !== current.items.length
      )
        throw new Error('请先逐项选择全部候选，给出本人的完整排序。');
      if (
        values.kind === 'parameter' &&
        (!a.trim() || !x.trim() || !Number.isFinite(values.a) || !Number.isFinite(values.x))
      )
        throw new Error('请输入有效实验数值。');
      if (
        values.kind === 'parameter' &&
        values.prediction !== null &&
        !Number.isFinite(values.prediction)
      )
        throw new Error('请输入有效的预测数值，或留空。');
      if (
        current.kind === 'parameter' &&
        values.kind === 'parameter' &&
        operation === 'submit' &&
        current.predictionRequired &&
        values.prediction === null
      )
        throw new Error('本版本要求先填写本人预测，再提交互动。');
      const digest = JSON.stringify({ operation, binding: state.binding, values });
      if (requestRef.current?.digest !== digest)
        requestRef.current = { digest, nonce: crypto.randomUUID() };
      const saved = await apiFetch('/api/study/formal-interactions', formalInteractionStateSchema, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          operation,
          scope,
          binding: state.binding,
          values,
          nonce: requestRef.current.nonce,
        }),
      });
      if (!controller.signal.aborted && epoch === epochRef.current) setState(saved);
    } catch (caught) {
      if (!controller.signal.aborted && epoch === epochRef.current)
        setError(describeApiError(caught));
    } finally {
      requests.current.delete(controller);
      if (!controller.signal.aborted && epoch === epochRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const definition = state?.definition;
  const numericA = Number(a);
  const intercept = definition?.kind === 'parameter' ? definition.intercept : 0;
  return (
    <div className="card" data-scene="interactive" data-formal-interaction data-scene-id={sceneId}>
      <h2>{definition?.title ?? '正在读取正式互动…'}</h2>
      <p className="secondary">
        本版本互动定义经人工对照来源审核。草稿与本人提交分别保存；服务核验反馈不直接改变掌握状态。
      </p>
      {definition?.kind === 'parameter' ? (
        <>
          <p>
            实验函数 {definition.formula === 'quadratic' ? 'f(x)=ax²+' : 'f(x)=ax+'}
            {definition.intercept}（{definition.formula === 'quadratic' ? '二次' : '线性'}
            ）。来源陈述：
            {definition.statementIds.join('、')}
          </p>
          <svg
            viewBox="0 0 400 220"
            role="img"
            aria-label={definition.formula === 'quadratic' ? '二次函数参数图' : '线性函数参数图'}
            style={{ width: '100%', height: 220 }}
          >
            <path d="M0 110H400M200 0V220" stroke="currentColor" fill="none" />
            {definition.formula === 'quadratic' ? (
              // 采样绘制抛物线：结果只用于可视化，判定仍由服务端按定义公式完成。
              <path
                d={Array.from({ length: 41 }, (_, index) => {
                  const x = -5 + (index * 10) / 40;
                  const y = 110 - (numericA * x * x + intercept) * 4;
                  return `${index === 0 ? 'M' : 'L'}${(x + 5) * 40} ${y}`;
                }).join('')}
                stroke="#0f766e"
                strokeWidth="3"
                fill="none"
              />
            ) : (
              <path
                d={`M0 ${110 - (-5 * numericA + intercept) * 15}L400 ${110 - (5 * numericA + intercept) * 15}`}
                stroke="#0f766e"
                strokeWidth="3"
                fill="none"
              />
            )}
          </svg>
          <label>
            参数 a
            <input
              data-formal-parameter
              type="number"
              min={definition.min}
              max={definition.max}
              step={definition.step}
              value={a}
              disabled={busy}
              onChange={(e) => setA(e.target.value)}
            />
          </label>
          <label>
            观察点 x
            <input
              data-formal-x
              type="number"
              min="-100"
              max="100"
              value={x}
              disabled={busy}
              onChange={(e) => setX(e.target.value)}
            />
          </label>
          <label>
            本人预测（先猜结果，再提交）
            {definition.predictionRequired ? ' · 本版本必填' : ' · 可留空'}
            <input
              data-formal-prediction
              type="number"
              step="any"
              value={prediction}
              disabled={busy}
              onChange={(e) => setPrediction(e.target.value)}
            />
          </label>
        </>
      ) : definition?.kind === 'concept_relation' ? (
        <>
          <p>
            节点：{definition.nodes.map((n) => n.label).join(' · ')}；来源陈述：
            {definition.statementIds.join('、')}
          </p>
          <label>
            选择关系
            <select
              data-formal-edge
              value={edgeId}
              disabled={busy}
              onChange={(e) => setEdgeId(e.target.value)}
            >
              {definition.edges.map((e) => (
                <option key={e.id} value={e.id}>
                  {definition.nodes.find((n) => n.id === e.from)?.label} — {e.label} → ?
                </option>
              ))}
            </select>
          </label>
          <label>
            目标概念
            <select
              data-formal-target
              value={to}
              disabled={busy}
              onChange={(e) => setTo(e.target.value)}
            >
              {definition.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          </label>
          <svg
            viewBox="0 0 500 140"
            role="img"
            aria-label="本人概念关系图"
            style={{ width: '100%', height: 140 }}
          >
            <rect x="10" y="35" width="170" height="70" rx="10" fill="#dbeafe" />
            <text x="20" y="75">
              {
                definition.nodes.find(
                  (n) => n.id === definition.edges.find((e) => e.id === edgeId)?.from,
                )?.label
              }
            </text>
            <path d="M180 70H300L285 60M300 70L285 80" stroke="#0f766e" fill="none" />
            <rect x="310" y="35" width="180" height="70" rx="10" fill="#ccfbf1" />
            <text x="320" y="75">
              {definition.nodes.find((n) => n.id === to)?.label}
            </text>
          </svg>
        </>
      ) : definition?.kind === 'ordering' ? (
        <>
          <p>
            请把下列概念排成正确顺序（上→下）。候选条目：{definition.items.length} 个；来源陈述：
            {definition.statementIds.join('、')}
          </p>
          <div data-formal-order-candidates>
            {definition.items
              .filter((item) => !order.includes(item.id))
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    setOrder((current) =>
                      current.includes(item.id) ? current : [...current, item.id],
                    )
                  }
                >
                  添加：{item.label}
                </button>
              ))}
          </div>
          <ol className="check-list" data-formal-order>
            {order.map((itemId, index) => (
              <li key={itemId}>
                <span>
                  {index + 1}. {definition.items.find((item) => item.id === itemId)?.label}
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || index === 0}
                  onClick={() =>
                    setOrder((current) => {
                      const next = [...current];
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      return next;
                    })
                  }
                >
                  上移
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || index === order.length - 1}
                  onClick={() =>
                    setOrder((current) => {
                      const next = [...current];
                      [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                      return next;
                    })
                  }
                >
                  下移
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setOrder((current) => current.filter((id) => id !== itemId))}
                >
                  移回候选
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <label>
        本人解释
        <textarea
          data-formal-explanation
          maxLength={2000}
          value={explanation}
          disabled={!state || busy}
          onChange={(e) => setExplanation(e.target.value)}
        />
      </label>
      <button className="btn" disabled={!state || busy} onClick={() => void save('draft')}>
        保存临时草稿
      </button>
      <button
        className="btn btn-primary"
        data-formal-submit
        disabled={!state || busy}
        onClick={() => void save('submit')}
      >
        {busy ? '正在核验…' : '提交本人互动'}
      </button>
      <button className="btn" disabled={busy} onClick={() => void load(epochRef.current)}>
        重新读取
      </button>
      {state?.draft ? <p role="status">本版本临时草稿已保存，可重开恢复。</p> : null}
      {state?.lastSubmission ? (
        <p role="status" data-formal-result>
          本人提交已保存，共 {state.count} 条。服务核验：{state.lastSubmission.payload.result}。
          {definition?.kind !== 'parameter'
            ? ''
            : state.lastSubmission.payload.predictionMatched === null
              ? '本次未填写预测。'
              : state.lastSubmission.payload.predictionMatched
                ? '本人预测与实测一致。'
                : '本人预测与实测不一致，可对照来源重做实验。'}
          {state.deduplicated ? '重复请求已复用。' : ''}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="error-text">
          {error} 可重新读取或再次提交。
        </p>
      ) : null}
    </div>
  );
}

export function FormalInteractiveSceneView(
  props: Parameters<typeof FormalInteractiveSceneContent>[0],
) {
  return (
    <FormalInteractiveSceneContent
      key={JSON.stringify([
        props.scope.projectId,
        props.scope.generation,
        props.stageId,
        props.sceneId,
      ])}
      {...props}
    />
  );
}
