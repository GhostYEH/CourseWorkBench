'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { apiResponses, classroomBoardContentSchema, type ClassroomBoardContentDto, type ClassroomBoardStateDto, type ClassroomSessionDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { Notice } from './ui';

/**
 * 公式排版。
 *
 * `trust: false` 是硬约束：KaTeX 不会把 `\href`/`\url`/`\includegraphics`/`\html*`
 * 变成真实链接或 HTML，因此渲染结果不会成为外链或脚本入口。
 * `throwOnError: false` 让写错的公式退化成可见的错误样式，而不是把整块白板炸掉；
 * 排版源码为空时回退到纯文本形式，绝不显示空白。
 */
const typesetFormula = (latex: string): string => katex.renderToString(latex, {
  throwOnError: false, trust: false, strict: 'ignore', displayMode: true, output: 'html',
});

/** Only committed, approved snapshots reach the teaching canvas. */
export const ClassroomBoardContent = ({ content }: { content: ClassroomBoardContentDto }): ReactNode => {
  if (content.kind === 'formula') {
    return <div className="reading" data-board-formula>
      {content.latex === null
        ? <code aria-label="公式">{content.text}</code>
        // KaTeX 在 trust:false 下自行转义，输出可安全注入；失败时它渲染的是错误样式而不是 HTML。
        : <span aria-label="公式" dangerouslySetInnerHTML={{ __html: typesetFormula(content.latex) }} />}
      {content.latex === null ? null : <span className="hint mono" style={{ display: 'block' }}>纯文本：{content.text}</span>}
    </div>;
  }
  if (content.kind === 'focus') {
    return <div className="reading" data-board-focus={content.elementId}>
      <strong>教师聚焦</strong>
      <p style={{ whiteSpace: 'pre-wrap' }}>{content.text}</p>
      <span className="hint mono">指向本场景已存在的元素：{content.elementId}</span>
    </div>;
  }
  if (content.kind !== 'diagram') return <div className="reading" style={{ whiteSpace: 'pre-wrap' }}>{content.text}</div>;
  return <svg viewBox="0 0 1000 1000" role="img" aria-label="已审核概念简图" style={{ width: '100%', maxHeight: 320 }}>
    {content.edges.map((edge, index) => {
      const from = content.nodes.find(node => node.id === edge.from);
      const to = content.nodes.find(node => node.id === edge.to);
      if (!from || !to) return null;
      return <g key={index}>
        <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" strokeWidth="4" />
        <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 20} fill="currentColor" fontSize="28" textAnchor="middle">{edge.label}</text>
      </g>;
    })}
    {content.nodes.map(node => <g key={node.id}>
      <rect x={node.x - 130} y={node.y - 45} width="260" height="90" rx="12" fill="var(--sew-bg-panel, #f4f6fb)" stroke="currentColor" strokeWidth="3" />
      <text x={node.x} y={node.y + 10} fill="currentColor" fontSize="30" textAnchor="middle">{node.label}</text>
    </g>)}
  </svg>;
};

export const ClassroomBoardPanel = ({ projectId, generation, session, playbackDisabled = false }: {
  projectId: string; generation: number; session: ClassroomSessionDto; playbackDisabled?: boolean;
}): ReactNode => {
  const [state, setState] = useState<ClassroomBoardStateDto | null>(null);
  const [statementIds, setStatementIds] = useState<string[]>([]);
  const [statementId, setStatementId] = useState('');
  const [kind, setKind] = useState<'text' | 'formula' | 'diagram' | 'highlight' | 'focus'>('text');
  const [text, setText] = useState('');
  /** 公式的数学排版源码；留空时只显示纯文本形式。 */
  const [latex, setLatex] = useState('');
  const [focusElementId, setFocusElementId] = useState('');
  const [elementIds, setElementIds] = useState<string[]>([]);
  const [nodeA, setNodeA] = useState('');
  const [nodeB, setNodeB] = useState('');
  const [relation, setRelation] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const epoch = useRef(0);
  const pending = useRef<{ intent: string; requestId: string } | null>(null);
  const scope = { projectId, generation };
  const refresh = async (signal?: AbortSignal): Promise<void> => {
    const result = await apiFetch(`/api/study/board?sessionId=${encodeURIComponent(session.sessionId)}&projectId=${encodeURIComponent(projectId)}&generation=${generation}`, apiResponses.classroomBoardContext, { signal });
    if (signal?.aborted) return;
    setState(result.state); setStatementIds(result.statementIds);
    setStatementId(old => result.statementIds.includes(old) ? old : result.statementIds[0] ?? '');
    setElementIds(result.elementIds);
    setFocusElementId(old => result.elementIds.includes(old) ? old : result.elementIds[0] ?? '');
  };
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal).catch(caught => { if (!abort.signal.aborted) setError(describeApiError(caught)); });
    return () => { abort.abort(); epoch.current += 1; };
  }, [session.sessionId, session.currentSceneId, projectId, generation]);
  const command = async (body: Record<string, unknown>): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setMessage(null);
    const turn = epoch.current;
    const intent = JSON.stringify(body);
    if (pending.current?.intent !== intent) pending.current = { intent, requestId: crypto.randomUUID() };
    try {
      const payload = JSON.stringify({ ...body, scope, requestId: pending.current.requestId });
      if (body.action === 'play') {
        const result = await apiFetch('/api/study/board', apiResponses.classroomBoardPlay, { method: 'POST', body: payload });
        if (turn !== epoch.current) return;
        setMessage(result.deduplicated ? '读回已提交白板，没有重复执行。' : '已显示审核过的白板内容。');
      } else {
        const result = await apiFetch('/api/study/board', apiResponses.classroomBoardItem, { method: 'POST', body: payload });
        if (turn !== epoch.current) return;
        setMessage(result.item.status === 'draft' ? '已保存白板草案，请核对内容与依据。' : '已保存本版本的审核结论。');
      }
      pending.current = null;
      if (turn === epoch.current) await refresh();
    } catch (caught) { if (turn === epoch.current) setError(describeApiError(caught)); }
    finally { lock.current = false; if (turn === epoch.current) setBusy(false); }
  };
  const active = session.status === 'in_class';
  const content = (): ClassroomBoardContentDto => classroomBoardContentSchema.parse(
    kind === 'diagram'
      ? { kind, nodes: [{ id: 'a', label: nodeA, x: 230, y: 500 }, { id: 'b', label: nodeB, x: 770, y: 500 }], edges: [{ from: 'a', to: 'b', ...(relation.trim() ? { label: relation } : {}) }] }
      : kind === 'highlight' ? { kind, statementId, text }
      : kind === 'focus' ? { kind, elementId: focusElementId, text }
      : kind === 'formula' ? { kind, text, latex: latex.trim() === '' ? null : latex.trim() }
      : { kind, text });
  return <section data-classroom-board className="card">
    <h3>课堂白板</h3>
    <p className="hint">草案须核对学科内容与来源后才能显示。已提交白板在重开后恢复，等待本人或结束后暂停新动作。</p>
    <div data-board-canvas aria-live="polite">
      {state?.effects.map(effect => <article key={effect.seq} className="card" data-board-effect={effect.seq}>
        <ClassroomBoardContent content={effect.item.content} />
        <p className="hint mono">#{effect.seq} · 依据 {effect.item.statementIds.join('、')} · 已审核</p>
      </article>)}
      {state?.effects.length === 0 ? <p className="muted">尚无已提交的白板内容。</p> : null}
    </div>
    <details>
      <summary>编写与审核白板</summary>
      <form onSubmit={event => {
        event.preventDefault();
        try { void command({ action: 'create', lessonId: session.lessonId, lessonVersion: session.lessonVersion,
          sceneId: session.currentSceneId, statementIds: [statementId], content: content() }); }
        catch { setError('请填写完整内容、概念名称与依据。'); }
      }}>
        <div className="field"><label>依据陈述<select data-board-statement value={statementId} disabled={busy || !active}
          onChange={event => setStatementId(event.target.value)}>
          {statementIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select></label></div>
        <div className="field"><label>内容类型<select data-board-kind value={kind} disabled={busy}
          onChange={event => setKind(event.target.value as typeof kind)}>
          <option value="text">文字</option><option value="formula">公式（数学排版）</option><option value="diagram">概念简图</option><option value="highlight">重点标注</option><option value="focus">教师聚焦</option>
        </select></label></div>
        {kind === 'diagram' ? <>
          <label>第一个概念<input value={nodeA} maxLength={40} onChange={event => setNodeA(event.target.value)} /></label>
          <label>第二个概念<input value={nodeB} maxLength={40} onChange={event => setNodeB(event.target.value)} /></label>
          <label>关系说明<input value={relation} maxLength={60} onChange={event => setRelation(event.target.value)} /></label>
        </> : kind === 'focus' ? <>
          <div className="field"><label>聚焦到本场景的元素<select data-board-focus-element value={focusElementId} disabled={busy || !active}
            onChange={event => setFocusElementId(event.target.value)}>
            {elementIds.length === 0 ? <option value="">本场景没有可聚焦的元素</option> : null}
            {elementIds.map(elementId => <option key={elementId} value={elementId}>{elementId}</option>)}
          </select></label></div>
          <label>聚焦说明<textarea data-board-text value={text} maxLength={4000} onChange={event => setText(event.target.value)} /></label>
        </> : <>
          <label>{kind === 'formula' ? '公式的纯文本形式（读屏与降级用）' : '白板内容'}<textarea data-board-text value={text} maxLength={4000} onChange={event => setText(event.target.value)} /></label>
          {kind === 'formula' ? <label>数学排版源码（LaTeX，可留空）<input data-board-latex value={latex} maxLength={2000} disabled={busy}
            onChange={event => setLatex(event.target.value)} /></label> : null}
        </>}
        <button data-board-create type="submit" className="btn" disabled={busy || !active || !statementId || (kind === 'focus' && !focusElementId)}>保存待核草案</button>
      </form>
      <label>审核说明<input data-board-review-note value={reviewNote} maxLength={1000} onChange={event => setReviewNote(event.target.value)} /></label>
      <label><input data-board-review-confirm type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />我已核对内容和来源支持</label>
      <ul>
        {state?.items.filter(item => item.sceneId === session.currentSceneId).map(item => <li key={item.itemId} data-board-item={item.itemId}>
          <p>{item.status === 'draft' ? '待审核' : item.status === 'approved' ? '已审核' : '已退回'} · v{item.version}</p>
          <ClassroomBoardContent content={item.content} />
          {item.status === 'draft' ? <button data-board-approve className="btn" disabled={busy || !active || !reviewed || !reviewNote.trim()}
            onClick={() => void command({ action: 'review', itemId: item.itemId, expectedVersion: item.version, decision: 'approved', semanticReviewed: true, note: reviewNote })}>批准本版本</button> : null}
          {item.status === 'approved' ? <button data-board-play className="btn" disabled={busy || playbackDisabled || !active || !state || state.effects.some(effect => effect.item.itemId === item.itemId)}
            onClick={() => void command({ action: 'play', sessionId: session.sessionId, itemId: item.itemId, expectedVersion: item.version, expectedSeq: state?.seq ?? 0 })}>显示到课堂白板</button> : null}
        </li>)}
      </ul>
    </details>
    {message ? <Notice tone="info">{message}</Notice> : null}
    {error ? <Notice tone="error" role="alert">{error}</Notice> : null}
  </section>;
};
