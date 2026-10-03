'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { SlideCanvas } from '@openmaic/renderer';
import type { Action, InteractiveContent, QuizContent, Scene, SlideContent } from '@openmaic/dsl';
import type { ClassroomSceneBinding } from '@sew/study-contracts';
import { QuizSceneView } from './QuizSceneView';

export type ClassroomScene = Scene<Action, SlideContent | QuizContent | InteractiveContent>;

function InteractiveScene({ sceneId, content }: { sceneId: string; content: InteractiveContent }) {
  const effectiveSceneId = sceneId || 'interactive-unknown';
  const html = content.html ?? '';
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [observation, setObservation] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const instanceId = useId();
  const srcDoc = useMemo(() => {
    const shim = `<script>(function(){var q=[];function report(kind,message){var m={__maicInteractive:true,kind:'runtime-error',errorKind:kind,message:String(message),instanceId:${JSON.stringify(instanceId)}};q.push(m);parent.postMessage(m,'*')}window.addEventListener('error',function(e){report('error',e.message||'runtime error')});window.addEventListener('unhandledrejection',function(e){report('unhandledrejection',e.reason||'unhandled rejection')});window.addEventListener('message',function(e){if(e.source===parent&&e.data&&e.data.__maicErrorReplayRequest===true)q.forEach(function(m){parent.postMessage(m,'*')})});})();</script>`;
    return /<\/body\s*>/i.test(html)
      ? html.replace(/<\/body\s*>/i, `${shim}</body>`)
      : `${shim}${html}`;
  }, [html, instanceId]);
  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      const data = event.data as { __maicInteractive?: unknown; kind?: unknown; type?: unknown; a?: unknown; direction?: unknown; nativeBridge?: unknown; nodeRequire?: unknown; instanceId?: unknown; message?: unknown } | null;
      if (!data || event.source !== frameRef.current?.contentWindow) return;
      if (data.__maicInteractive === true && data.kind === 'runtime-error') {
        if (data.instanceId !== instanceId) return;
        setObservation(`互动组件运行错误（仅供诊断）：${String(data.message ?? 'unknown')}`);
        return;
      }
      if (data.type === 'widget-observation') {
        setObservation(`组件自报 a=${String(data.a)}，方向=${String(data.direction)}，nativeBridge=${String(data.nativeBridge)}，nodeRequire=${String(data.nodeRequire)}（低信任观察，不作为判分依据）`);
      }
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
    };
  }, [instanceId]);
  return (
    <div className="card" data-scene="interactive" data-scene-id={effectiveSceneId}>
      <h2>参数实验</h2>
      <p className="secondary">调整参数并观察变化。组件自报的结果仅供观察，不计入测验成绩或掌握状态。</p>
      <p className="muted" role="status" data-interactive-ready>{ready ? '互动内容已加载' : '正在加载互动内容…'}</p>
      <iframe
        key={html}
        ref={frameRef}
        title="参数实验互动"
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => {
          setReady(true);
          frameRef.current?.contentWindow?.postMessage({ __maicErrorReplayRequest: true, instanceId }, '*');
        }}
        style={{ width: '100%', height: '320px', border: '1px solid var(--sew-border-divider)', background: 'var(--sew-surface-document)' }}
      />
      {observation ? <p className="muted" role="status" data-widget-observation>{observation}</p> : null}
    </div>
  );
}

/** Adapted from OpenMAIC's components/stage/scene-renderer.tsx discriminant dispatcher. */
export function SceneRenderer({
  scene,
  bindings,
  scope,
}: {
  scene: ClassroomScene;
  bindings: ClassroomSceneBinding[];
  scope: { projectId: string; generation: number };
}) {
  const binding = bindings.find((item) => item.sceneId === scene.id);
  switch (scene.type) {
    case 'slide':
      return scene.content.type === 'slide' ? (
        <div className="card" data-scene="slide" data-scene-id={scene.id}>
          <h2>{scene.title}</h2>
          <div style={{ width: '100%', aspectRatio: '16 / 9', background: 'var(--sew-surface-document)' }}>
            <SlideCanvas slide={scene.content.canvas} />
          </div>
          <p className="muted">本页为演示课件，来源与审核记录见右侧。</p>
        </div>
      ) : <p role="alert">幻灯片场景结构无效。</p>;
    case 'quiz':
      return scene.content.type === 'quiz' ? (
        <QuizSceneView
          content={scene.content}
          sceneId={scene.id}
          stageId={scene.stageId}
          scope={scope}
          questionId={binding?.questionId ?? undefined}
          reviewedBy={binding?.reviewedBy}
        />
      ) : <p role="alert">测验场景结构无效。</p>;
    case 'interactive':
      return scene.content.type === 'interactive'
        ? <InteractiveScene sceneId={scene.id} content={scene.content} />
        : <p role="alert">互动场景结构无效。</p>;
    default:
      return <p role="status">未知场景类型暂不能播放。</p>;
  }
}
