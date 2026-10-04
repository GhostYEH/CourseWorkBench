'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { InteractiveContent } from '@openmaic/dsl';
import { interactionDirectionSchema, interactionStateSchema, type InteractionStateDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../../lib/client';

type Scope = { projectId: string; generation: number };
type Direction = 'increasing' | 'decreasing' | 'constant';
const directionLabel = { increasing: '递增', decreasing: '递减', constant: '恒为 0' };

/** Error capture precedes widget scripts; the sandbox remains a diagnostic source only. */
export const interactiveSrcDoc = (html: string, instanceId: string): string => {
  const shim = `<script>(function(){var q=[];function report(kind,message){var m={__maicInteractive:true,kind:'runtime-error',errorKind:kind,message:String(message).slice(0,1200),instanceId:${JSON.stringify(instanceId)}};q.push(m);if(q.length>50)q.shift();parent.postMessage(m,'*')}window.addEventListener('error',function(e){report('error',e.message||'resource load error')},true);window.addEventListener('unhandledrejection',function(e){report('unhandledrejection',e.reason||'unhandled rejection')});window.addEventListener('message',function(e){if(e.source===parent&&e.data&&e.data.__maicErrorReplayRequest===true&&e.data.instanceId===${JSON.stringify(instanceId)})q.forEach(function(m){parent.postMessage(m,'*')})});})();</script>`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${shim}`)
    : `${shim}${html}`;
};

export function InteractiveSceneView({ sceneId, stageId, content, scope }: { sceneId: string; stageId: string; content: InteractiveContent; scope: Scope }) {
  const html = content.html ?? '';
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const epochRef = useRef(0);
  const busyRef = useRef(false);
  const [observation, setObservation] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState('1');
  const [prediction, setPrediction] = useState<Direction>('increasing');
  const [explanation, setExplanation] = useState('');
  const [saved, setSaved] = useState<InteractionStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const instanceId = useId();
  const srcDoc = useMemo(() => interactiveSrcDoc(html, instanceId), [html, instanceId]);
  const headers = useMemo(() => ({ 'x-sew-project-id': scope.projectId, 'x-sew-generation': String(scope.generation) }), [scope.projectId, scope.generation]);
  const restore = useCallback(async (epoch: number): Promise<void> => {
    setError(null);
    try {
      const data = interactionStateSchema.parse(await apiFetch<unknown>(`/api/maic/interaction?stageId=${encodeURIComponent(stageId)}&sceneId=${encodeURIComponent(sceneId)}`, { headers, cache: 'no-store' }));
      if (epochRef.current !== epoch) return;
      setSaved(data);
      if (data.lastSubmission) {
        setA(String(data.lastSubmission.payload.a));
        setPrediction(data.lastSubmission.payload.prediction);
        setExplanation(data.lastSubmission.payload.explanation);
      }
      setReady(true);
    } catch (caught) { if (epochRef.current === epoch) setError(describeApiError(caught)); }
  }, [headers, sceneId, stageId]);
  useEffect(() => {
    const epoch = ++epochRef.current;
    setReady(false); setSaved(null); setA('1'); setPrediction('increasing'); setExplanation('');
    busyRef.current = false; setBusy(false);
    void restore(epoch);
    return () => { if (epochRef.current === epoch) epochRef.current += 1; };
  }, [restore]);
  useEffect(() => {
    setObservation(null); setRuntimeError(null); setFrameReady(false);
    const receive = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const data = event.data as Record<string, unknown>;
      if (data['__maicInteractive'] === true && data['kind'] === 'runtime-error') {
        if (data['instanceId'] !== instanceId || typeof data['message'] !== 'string') return;
        setRuntimeError(`互动组件运行错误（仅供诊断）：${data['message'].slice(0, 1200)}`);
      } else if (data['type'] === 'widget-observation') {
        if (typeof data['a'] !== 'number' || !Number.isFinite(data['a']) || typeof data['direction'] !== 'string' || typeof data['nativeBridge'] !== 'string' || typeof data['nodeRequire'] !== 'string') return;
        setObservation(`组件自报 a=${data['a']}，方向=${data['direction'].slice(0, 60)}，nativeBridge=${data['nativeBridge'].slice(0, 30)}，nodeRequire=${data['nodeRequire'].slice(0, 30)}（低信任观察，不作为判分依据）`);
      }
    };
    window.addEventListener('message', receive);
    frameRef.current?.contentWindow?.postMessage({ __maicErrorReplayRequest: true, instanceId }, '*');
    return () => window.removeEventListener('message', receive);
  }, [instanceId, html]);
  const submit = async (): Promise<void> => {
    if (!ready || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    const epoch = epochRef.current;
    try {
      const value = Number(a);
      if (a.trim() === '' || !Number.isFinite(value)) throw new Error('请填写有效的参数 a。');
      const data = interactionStateSchema.parse(await apiFetch<unknown>('/api/maic/interaction', {
        method: 'POST', headers, body: JSON.stringify({ scope, stageId, sceneId, a: value, prediction, explanation }),
      }));
      if (epochRef.current === epoch) setSaved(data);
    } catch (caught) { if (epochRef.current === epoch) setError(describeApiError(caught)); }
    finally { if (epochRef.current === epoch) { busyRef.current = false; setBusy(false); } }
  };
  return (
    <div className="card" data-scene="interactive" data-scene-id={sceneId}>
      <h2>参数实验</h2>
      <p className="secondary">调整参数并观察 f(x)=ax。下方由本人填写并明确提交，保存后可在重启时读回；不计入测验成绩或掌握状态。</p>
      <p className="muted">上方互动组件的即时参数会在离开场景或重启后重置；下方已提交的本人参数、预测和解释保留。</p>
      <p className="muted" role="status" data-interactive-ready>{frameReady ? '互动内容已加载' : '正在加载互动内容…'}</p>
      <iframe key={html} ref={frameRef} title="参数实验互动" srcDoc={srcDoc} sandbox="allow-scripts" referrerPolicy="no-referrer"
        onLoad={() => { setFrameReady(true); frameRef.current?.contentWindow?.postMessage({ __maicErrorReplayRequest: true, instanceId }, '*'); }}
        style={{ width: '100%', height: '320px', border: '1px solid var(--sew-border-divider)', background: 'var(--sew-surface-document)' }} />
      {observation ? <p className="muted" role="status" data-widget-observation>{observation}</p> : null}
      {runtimeError ? <p className="error-text" role="alert" data-interactive-runtime-error>{runtimeError}</p> : null}
      <div data-interaction-ready={ready ? 'true' : 'false'}>
        <div className="field"><label htmlFor={`${instanceId}-a`}>本人实验参数 a（-3 至 3，步长 0.1）</label>
          <input id={`${instanceId}-a`} type="number" min="-3" max="3" step="0.1" data-interaction-parameter value={a} disabled={!ready || busy} onChange={(event) => setA(event.target.value)} /></div>
        <div className="field"><label htmlFor={`${instanceId}-prediction`}>本人预测</label>
          <select id={`${instanceId}-prediction`} data-interaction-prediction value={prediction} disabled={!ready || busy} onChange={(event) => { const value = interactionDirectionSchema.safeParse(event.target.value); if (value.success) setPrediction(value.data); }}>
            <option value="increasing">递增</option><option value="decreasing">递减</option><option value="constant">恒为 0</option>
          </select></div>
        <div className="field"><label htmlFor={`${instanceId}-explanation`}>本人解释（选填）</label>
          <textarea id={`${instanceId}-explanation`} data-interaction-explanation maxLength={2000} value={explanation} disabled={!ready || busy} onChange={(event) => setExplanation(event.target.value)} /></div>
        <button type="button" className="btn btn-primary" data-interaction-submit disabled={!ready || busy} onClick={() => void submit()}>{busy ? '正在核验并保存…' : '提交本人实验记录'}</button>
        {!ready ? <button type="button" className="btn" onClick={() => void restore(epochRef.current)}>重新读取实验记录</button> : null}
        {saved?.lastSubmission ? <p role="status" data-interaction-result data-record-id={saved.lastSubmission.id}>
          已保存本人实验记录：a={saved.lastSubmission.payload.a}，预测{directionLabel[saved.lastSubmission.payload.prediction]}，服务核验方向{directionLabel[saved.lastSubmission.payload.direction]}。共 {saved.count} 条。{saved.deduplicated ? '重复提交已复用既有记录。' : ''}不产生判分或掌握状态。
        </p> : null}
        {error ? <p role="alert" className="error-text">{error} 可重新读取或再次提交。</p> : null}
      </div>
    </div>
  );
}
