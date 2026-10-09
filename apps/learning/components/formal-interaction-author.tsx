'use client';
import { useEffect, useRef, useState } from 'react';
import {
  formalInteractionFrozenSchema,
  type BundleStatementDto,
  type FormalInteractionDefinitionDto,
  type ParameterFormula,
} from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { createOrderingItemsCache } from '../lib/formal-ordering';
import { parseProceduralSkillDraft } from '../lib/procedural-skill-authoring';

export function FormalInteractionAuthor({
  scope,
  lessonId,
  lessonVersion,
  statements,
}: {
  scope: { projectId: string; generation: number };
  lessonId: string;
  lessonVersion: number;
  statements: BundleStatementDto[];
}) {
  const [parameter, setParameter] = useState(false);
  const [relation, setRelation] = useState(false);
  const [predictionRequired, setPredictionRequired] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [min, setMin] = useState('-3');
  const [max, setMax] = useState('3');
  const [step, setStep] = useState('0.1');
  const [intercept, setIntercept] = useState('0');
  /** 参数实验公式（VIS-01 的「其余参数组件」）：结果由服务端按它核验。 */
  const [formula, setFormula] = useState<ParameterFormula>('linear');
  const [nodes, setNodes] = useState('');
  const [edges, setEdges] = useState('');
  const [note, setNote] = useState('');
  const [ordering, setOrdering] = useState(false);
  /** 排序条目：每行一个标签，行顺序即正确顺序。 */
  const [orderItems, setOrderItems] = useState('');
  /** 步骤技能训练（OMA-085）：工具每行一个；步骤每行 `标签 | 工具序号 | 判据 | 后果`。 */
  const [procedural, setProcedural] = useState(false);
  const [procedureTask, setProcedureTask] = useState('');
  const [procedureType, setProcedureType] = useState<
    'repair' | 'assembly' | 'inspection' | 'operation' | 'custom'
  >('operation');
  const [procedureTools, setProcedureTools] = useState('');
  const [procedureSteps, setProcedureSteps] = useState('');
  const orderingItemsCache = useRef<{
    scope: string;
    read: ReturnType<typeof createOrderingItemsCache>;
  } | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    setReady(false);
    void apiFetch(
      `/api/study/formal-interactions?lessonId=${encodeURIComponent(lessonId)}&lessonVersion=${lessonVersion}`,
      formalInteractionFrozenSchema.nullable(),
      {
        headers: {
          'x-sew-project-id': scope.projectId,
          'x-sew-generation': String(scope.generation),
        },
        cache: 'no-store',
      },
    )
      .then((frozen) => {
        if (!active) return;
        if (frozen) {
          setSaved(true);
          setChecked(true);
          setNote(frozen.reviewNote);
          setSelected([...new Set(frozen.definitions.flatMap((d) => d.statementIds))]);
          for (const definition of frozen.definitions) {
            if (definition.kind === 'parameter') {
              setParameter(true);
              setFormula(definition.formula);
              setMin(String(definition.min));
              setMax(String(definition.max));
              setStep(String(definition.step));
              setIntercept(String(definition.intercept));
              setPredictionRequired(definition.predictionRequired);
            } else if (definition.kind === 'ordering') {
              setOrdering(true);
              setOrderItems(definition.items.map((item) => item.label).join('\n'));
            } else if (definition.kind === 'procedural_skill') {
              setProcedural(true);
              setProcedureTask(definition.task);
              setProcedureType(definition.procedureType);
              setProcedureTools(definition.tools.map((tool) => tool.label).join('\n'));
              setProcedureSteps(
                definition.steps
                  .map((step) => {
                    const toolIndex = definition.tools.findIndex(
                      (tool) => tool.id === step.correctToolId,
                    );
                    return `${step.label} | ${toolIndex + 1} | ${step.successCriteria} | ${step.errorConsequences}`;
                  })
                  .join('\n'),
              );
            } else {
              setRelation(true);
              setNodes(definition.nodes.map((n) => n.label).join('\n'));
              setEdges(definition.edges.map((e) => `${e.from} | ${e.label} | ${e.to}`).join('\n'));
            }
          }
        }
        setReady(true);
      })
      .catch((caught) => {
        if (active) setError(describeApiError(caught));
      });
    return () => {
      active = false;
    };
  }, [lessonId, lessonVersion, scope.projectId, scope.generation]);
  const freeze = async () => {
    setBusy(true);
    setError(null);
    try {
      const definitions: FormalInteractionDefinitionDto[] = [];
      if (parameter)
        definitions.push({
          id: 'parameter',
          title: formula === 'quadratic' ? '二次函数参数实验' : '线性函数参数实验',
          kind: 'parameter',
          formula,
          statementIds: selected,
          min: Number(min),
          max: Number(max),
          step: Number(step),
          intercept: Number(intercept),
          predictionRequired,
        });
      if (relation)
        definitions.push({
          id: 'relation',
          title: '概念关系图',
          kind: 'concept_relation',
          statementIds: selected,
          nodes: nodes
            .split('\n')
            .filter((s) => s.trim())
            .map((label, i) => ({ id: `n${i + 1}`, label: label.trim() })),
          edges: edges
            .split('\n')
            .filter((s) => s.trim())
            .map((line, i) => {
              const [from = '', label = '', to = ''] = line.split('|').map((s) => s.trim());
              return { id: `e${i + 1}`, from, label, to };
            }),
        });
      if (ordering) {
        // 每行一个条目；行顺序就是正确顺序（`correctOrder`），服务端据此核验本人提交的排序。
        const cacheScope = [scope.projectId, scope.generation, lessonId, lessonVersion].join(':');
        if (orderingItemsCache.current?.scope !== cacheScope) {
          orderingItemsCache.current = { scope: cacheScope, read: createOrderingItemsCache() };
        }
        const { items, correctOrder } = orderingItemsCache.current.read(orderItems);
        definitions.push({
          id: 'ordering',
          title: '概念排序',
          kind: 'ordering',
          statementIds: selected,
          items,
          correctOrder,
        });
      }
      if (procedural) {
        const draft = parseProceduralSkillDraft(procedureTools, procedureSteps);
        if (draft.tools.length < 2 || draft.steps.length < 2) {
          setError(
            '步骤技能至少需要 2 个工具与 2 个步骤；请检查每行格式「标签 | 工具序号 | 判据 | 后果」。',
          );
          return;
        }
        definitions.push({
          id: 'procedural',
          title: procedureTask.trim() || '步骤技能训练',
          kind: 'procedural_skill',
          statementIds: selected,
          procedureType,
          task: procedureTask.trim() || '按顺序完成操作步骤',
          tools: draft.tools,
          steps: draft.steps,
          correctOrder: draft.correctOrder,
        });
      }
      // 合同上限是每版本 2 个互动定义：界面上先挡一次，避免用户填了半天才被服务端拒绝。
      if (definitions.length > 2) {
        setError('每版本最多冻结 2 个互动定义，请取消勾选后再试。');
        return;
      }
      await apiFetch('/api/study/formal-interactions', formalInteractionFrozenSchema, {
        method: 'POST',
        headers: {
          'x-sew-project-id': scope.projectId,
          'x-sew-generation': String(scope.generation),
        },
        body: JSON.stringify({
          operation: 'review',
          scope,
          lessonId,
          lessonVersion,
          semanticReviewed: checked,
          reviewNote: note,
          definitions,
        }),
      });
      setSaved(true);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details data-formal-interaction-author>
      <summary>本草案的可视化互动定义与审核</summary>
      <p>
        先逐条核对下列冻结陈述是否支持公式、参数范围与概念关系。冻结后再审核课程；同一版本定义不可替换。
      </p>
      <fieldset disabled={!ready || busy || saved}>
        <legend>来源陈述</legend>
        {statements.map((s) => (
          <label key={s.statementId} style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={selected.includes(s.statementId)}
              onChange={(e) =>
                setSelected((previous) =>
                  e.target.checked
                    ? [...previous, s.statementId]
                    : previous.filter((id) => id !== s.statementId),
                )
              }
            />
            {s.text}（
            {s.evidence
              .map((ref) => `${ref.materialId}#${ref.segmentId}@r${ref.revision}`)
              .join('、')}
            ）
          </label>
        ))}
      </fieldset>
      <fieldset disabled={!ready || busy || saved}>
        <legend>互动类型</legend>
        <label>
          <input
            type="checkbox"
            checked={parameter}
            onChange={(e) => setParameter(e.target.checked)}
          />
          参数实验（仅当来源明确支持所选公式时选用）
        </label>
        {parameter ? (
          <>
            <label>
              实验公式
              <select
                data-formal-parameter-formula
                value={formula}
                onChange={(e) => setFormula(e.target.value as ParameterFormula)}
              >
                <option value="linear">线性 f(x)=ax+b</option>
                <option value="quadratic">二次 f(x)=ax²+b</option>
              </select>
            </label>
            <label>
              a 最小值
              <input value={min} onChange={(e) => setMin(e.target.value)} type="number" />
            </label>
            <label>
              a 最大值
              <input value={max} onChange={(e) => setMax(e.target.value)} type="number" />
            </label>
            <label>
              步长
              <input value={step} onChange={(e) => setStep(e.target.value)} type="number" />
            </label>
            <label>
              固定截距 b
              <input
                value={intercept}
                onChange={(e) => setIntercept(e.target.value)}
                type="number"
              />
            </label>
            <label>
              <input
                data-formal-prediction-required
                type="checkbox"
                checked={predictionRequired}
                onChange={(e) => setPredictionRequired(e.target.checked)}
              />
              要求本人先给出预测再提交（冻结进本版本定义，改动需重新审核）
            </label>
          </>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={relation}
            onChange={(e) => setRelation(e.target.checked)}
          />
          概念关系
        </label>
        {relation ? (
          <>
            <label>
              概念节点（每行一个，顺序编号 n1、n2…）
              <textarea value={nodes} onChange={(e) => setNodes(e.target.value)} />
            </label>
            <label>
              经来源核对的关系（每行：n1 | 关系名称 | n2）
              <textarea value={edges} onChange={(e) => setEdges(e.target.value)} />
            </label>
          </>
        ) : null}
        <label>
          <input
            data-formal-ordering
            type="checkbox"
            checked={ordering}
            onChange={(e) => setOrdering(e.target.checked)}
          />
          概念排序（本人排出正确顺序）
        </label>
        {ordering ? (
          <label>
            排序条目（每行一个，**行顺序即正确顺序**；本人看到的是打乱后的候选）
            <textarea
              data-formal-ordering-items
              value={orderItems}
              onChange={(e) => setOrderItems(e.target.value)}
            />
          </label>
        ) : null}
        <label>
          <input
            data-formal-procedural
            type="checkbox"
            checked={procedural}
            onChange={(e) => setProcedural(e.target.checked)}
          />
          步骤技能训练（本人按正确顺序执行步骤并为每步选工具）
        </label>
        {procedural ? (
          <>
            <label>
              任务说明
              <input
                data-formal-procedure-task
                value={procedureTask}
                onChange={(e) => setProcedureTask(e.target.value)}
              />
            </label>
            <label>
              工序类型
              <select
                data-formal-procedure-type
                value={procedureType}
                onChange={(e) => setProcedureType(e.target.value as typeof procedureType)}
              >
                <option value="repair">检修</option>
                <option value="assembly">装配</option>
                <option value="inspection">检查</option>
                <option value="operation">操作</option>
                <option value="custom">其他</option>
              </select>
            </label>
            <label>
              工具/器材（每行一个，顺序编号 1、2…）
              <textarea
                data-formal-procedure-tools
                value={procedureTools}
                onChange={(e) => setProcedureTools(e.target.value)}
              />
            </label>
            <label>
              步骤（每行：步骤标签 | 工具序号 | 成功判据 | 错误后果；**行顺序即正确执行顺序**）
              <textarea
                data-formal-procedure-steps
                value={procedureSteps}
                onChange={(e) => setProcedureSteps(e.target.value)}
              />
            </label>
          </>
        ) : null}
        <label>
          审核依据与适用条件
          <textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          我已对照来源核对公式、范围、节点及关系，确认语义支持
        </label>
        <button
          type="button"
          className="btn"
          disabled={
            !checked || !selected.length || (!parameter && !relation && !ordering && !procedural)
          }
          onClick={() => void freeze()}
        >
          人工审核并冻结本版本互动
        </button>
      </fieldset>
      {saved ? <p role="status">本版本互动定义已冻结，请继续课程审核、发布与挂接。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
