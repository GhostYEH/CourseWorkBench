'use client';

import { apiResponses } from '@sew/study-contracts';

import { Notice } from './ui';
import { ClassroomPanel } from './classroom-panel';

/**
 * M0 OpenMAIC ClassroomSurface 适配入口：用真实上游 Stage/PlaybackEngine 场景与时间线生命周期。
 *
 * 文档由受项目代次保护的 `HttpDocumentStore` 读取，Stage 与 PlaybackEngine
 * 适配自 OpenMAIC 真实源码；生成/editor/AI 模式不属于 M0。
 *
 * 保留的边界：
 * - 测验判分由服务完成，文档里没有答案；
 * - 互动跑在 `sandbox="allow-scripts"` 的 iframe 内，没有 preload、Node 与主窗口控制；
 * - 播放位置写入 SQLite，浏览器缓存不作为恢复来源。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { HttpAssetStore } from '@openmaic/storage/asset/http';
import { HttpDocumentStore } from '@openmaic/storage/document/http';
import type { Action, InteractiveContent, QuizContent, Scene, SlideContent } from '@openmaic/dsl';
import type { ClassroomSceneBinding } from '@sew/study-contracts';
import { apiFetch, getSessionToken } from '../lib/client';
import { Stage } from './openmaic-adaptation/Stage';
import { SceneRenderer } from './openmaic-adaptation/SceneRenderer';
import { runClassroomLoad } from './openmaic-adaptation/classroom-load-lifecycle';
import { createClassroomLifecycle, type ClassroomLifecycleLease } from './openmaic-adaptation/host-lifecycle';
import { useOpenMaicClassroomLoad, type OpenMaicHostLoadResult } from './openmaic-adaptation/useOpenMaicClassroomLoad';
import {
  DEMO_ASSET_SCENE_ID,
  DEMO_FONT_REF,
  DEMO_FONT_SHA256,
  DEMO_FORMULA_FONT_FAMILY,
  DEMO_IMAGE_REF,
  DEMO_IMAGE_SHA256,
} from '../lib/classroom/demo-asset-refs';

type LessonScene = Scene<Action, SlideContent | QuizContent | InteractiveContent>;

interface LoadedDocument {
  stage: { id: string; name: string; description?: string };
  scenes: LessonScene[];
}

const KIND_LABEL: Record<string, string> = {
  slide: '幻灯片',
  quiz: '测验',
  interactive: '互动',
};

const orderedScenes = (document: LoadedDocument): LessonScene[] =>
  [...document.scenes].sort((a, b) => a.order - b.order);

/**
 * 会话凭据由 preload（打包运行）或 devToken（开发运行）在各自的 effect 里注入，
 * 与本组件加载文档的 effect 之间没有先后保证。先等凭据到位再拉文档，
 * 否则首帧会以 SESSION_REQUIRED 失败且不再重试。
 */
const waitForSessionToken = async (timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!getSessionToken() && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
};

const hashUrlBytes = async (url: string): Promise<string> => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`资源读取失败（${response.status}）。请检查项目资源或从备份恢复后重试。`);
  const digest = await window.crypto.subtle.digest('SHA-256', await response.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const waitForImage = (url: string): Promise<void> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => image.naturalWidth > 0
    ? resolve()
    : reject(new Error('演示图片没有有效尺寸，请检查项目资源或从备份恢复后重试。'));
  image.onerror = () => reject(new Error('演示图片无法解码，请检查项目资源或从备份恢复后重试。'));
  image.src = url;
});

export const ClassroomSurface = ({
  lessonId,
  projectId,
  generation,
  stageId,
  bindings,
  initialSceneId,
  recordScope,
  lessonTitle,
  teacher = null,
}: {
  lessonId: string;
  projectId: string;
  generation: number;
  stageId: string;
  bindings: ClassroomSceneBinding[];
  initialSceneId: string;
  recordScope: 'demo' | 'formal';
  lessonTitle: string;
  teacher?: { lessonVersion: number; stageId: string; roomId?: string } | null;
}) => {
  const [scenes, setScenes] = useState<LessonScene[] | null>(null);
  const [sceneId, setSceneId] = useState(initialSceneId);
  const releaseLoadRef = useRef<(() => void) | null>(null);
  const lifecycleRef = useRef(createClassroomLifecycle());
  const activeLeaseRef = useRef<ClassroomLifecycleLease | null>(null);
  const positionSaving = useRef(false);
  const [positionState, setPositionState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [positionError, setPositionError] = useState<string | null>(null);
  const sceneIdRef = useRef(initialSceneId);
  sceneIdRef.current = sceneId;

  const store = useMemo(
    () =>
      new HttpDocumentStore({
        baseUrl: '/api/maic',
        headers: (): HeadersInit => {
          const token = getSessionToken();
          return {
            ...(token ? { 'x-sew-session': token } : {}),
            'x-sew-project-id': projectId,
            'x-sew-generation': String(generation),
          };
        },
      }),
    [projectId, generation],
  );

  const releaseDocumentAndAssets = useCallback(() => {
    releaseLoadRef.current?.();
    releaseLoadRef.current = null;
  }, []);

  const loadDocumentAndAssets = useCallback(async (hostIsCurrent: () => boolean): Promise<OpenMaicHostLoadResult> => {
    releaseDocumentAndAssets();
    const lease = lifecycleRef.current.claim();
    activeLeaseRef.current = lease;
    // Dispose the prior Stage before loading another project/document or retry.
    // Playback and scene-local async work must not survive a new load epoch.
    setScenes(null);
    setPositionError(null);
    setPositionState('idle');
    positionSaving.current = false;
    const isCurrent = () => hostIsCurrent() && lease.isCurrent();
    const assetStore = new HttpAssetStore({
      baseUrl: '/api/maic',
      headers: (): HeadersInit => {
        const token = getSessionToken();
        return {
          ...(token ? { 'x-sew-session': token } : {}),
          'x-sew-project-id': projectId,
          'x-sew-generation': String(generation),
        };
      },
    });
    const ownedRefs: string[] = [];
    let loadedFont: FontFace | null = null;
    const releaseAssets = async (): Promise<void> => {
      if (loadedFont) {
        document.fonts.delete(loadedFont);
        loadedFont = null;
      }
      await Promise.all(ownedRefs.splice(0).map((assetId) => assetStore.release(assetId)));
    };
    releaseLoadRef.current = () => {
      lease.cancel();
      void releaseAssets();
      void assetStore.close();
    };
      try {
        await waitForSessionToken();
        // 演示课件的图片与公式字体是仓库内登记的固定资源；正式课件本轮只用文本场景，
        // 不能拿演示资源清单去要求正式课时，也不能因此跳过真实文档加载。
        let demoImageUrl = '';
        if (recordScope === 'demo') {
          const assetResult = await apiFetch(`/api/maic/demo-assets/${encodeURIComponent(stageId)}`, apiResponses.classroomAssets, {
            headers: { 'x-sew-project-id': projectId, 'x-sew-generation': String(generation) },
          });
          if (!isCurrent()) return { outcome: 'cancelled' };
          const expected = new Map([[DEMO_IMAGE_REF, DEMO_IMAGE_SHA256], [DEMO_FONT_REF, DEMO_FONT_SHA256]]);
          const urls = new Map<string, string>();
          for (const asset of assetResult.assets) {
            const expectedHash = expected.get(asset.symbolicRef);
            if (!expectedHash || asset.sha256 !== expectedHash) {
              throw new Error('课堂资源清单校验失败。请重新导入审核课件。');
            }
            ownedRefs.push(asset.assetId);
            const url = await assetStore.resolve(asset.assetId);
            if (!url) throw new Error(`课堂资源缺失（${asset.symbolicRef}）。请检查项目资源或从备份恢复后重试。`);
            if (!isCurrent()) return { outcome: 'cancelled' };
            const actualHash = await hashUrlBytes(url);
            if (!isCurrent()) return { outcome: 'cancelled' };
            if (actualHash !== expectedHash) {
              throw new Error(`课堂资源完整性校验失败（${asset.symbolicRef}）。已停止课堂渲染，请检查项目资源或从备份恢复后重试。`);
            }
            urls.set(asset.symbolicRef, url);
          }
          const imageUrl = urls.get(DEMO_IMAGE_REF);
          const fontUrl = urls.get(DEMO_FONT_REF);
          if (!imageUrl || !fontUrl || assetResult.assets.length !== 2) {
            throw new Error('审核课件图片或字体绑定缺失。请检查项目资源或从备份恢复后重试。');
          }
          await waitForImage(imageUrl);
          if (!isCurrent()) return { outcome: 'cancelled' };
          loadedFont = new FontFace(
            DEMO_FORMULA_FONT_FAMILY,
            `url(${JSON.stringify(fontUrl)}) format("woff2")`,
            { style: 'normal', weight: '400' },
          );
          await loadedFont.load();
          if (!isCurrent()) return { outcome: 'cancelled' };
          document.fonts.add(loadedFont);
          if (!document.fonts.check(`16px "${DEMO_FORMULA_FONT_FAMILY}"`)) {
            throw new Error('公式字体未能在浏览器中加载。请检查课堂资源后重试。');
          }
          if (!isCurrent()) return { outcome: 'cancelled' };
          demoImageUrl = imageUrl;
        }
        if (!isCurrent()) return { outcome: 'cancelled' };
        const loadResult = await runClassroomLoad({
          isCurrent,
          loadFromAuthoritativeStore: async () => (await store.loadDocument(stageId)) ?? undefined,
          applyDocument: (lessonDocument) => {
            if (recordScope === 'demo') {
              const slide = lessonDocument.scenes.find((scene) => scene.id === DEMO_ASSET_SCENE_ID && scene.type === 'slide');
              const image = slide?.type === 'slide'
                ? slide.content.canvas.elements.find((element) => element.id === 'slide-1-demo-image')
                : undefined;
              if (!image || image.type !== 'image' || image.src !== DEMO_IMAGE_REF) {
                throw new Error('课堂文档中的图片引用与审核清单不符。已停止课堂渲染。');
              }
              image.src = demoImageUrl;
            }
            const next = orderedScenes(lessonDocument as unknown as LoadedDocument);
            setScenes(next);
            if (next.length > 0 && !next.some((scene) => scene.id === sceneIdRef.current)) {
              setSceneId(next[0]!.id);
            }
          },
        });
        if (loadResult.outcome === 'cancelled') return { outcome: 'cancelled' };
        if (loadResult.outcome === 'unavailable' || loadResult.outcome === 'failed') throw loadResult.error;
        if (loadResult.outcome === 'absent') {
          await releaseAssets();
          if (!isCurrent()) return { outcome: 'cancelled' };
          setScenes([]);
          return { outcome: 'absent' };
        }
        return { outcome: 'ready', classroomId: stageId };
      } catch (caught) {
        if (!isCurrent()) {
          await releaseAssets();
          return { outcome: 'cancelled' };
        }
        await releaseAssets();
        if (!isCurrent()) return { outcome: 'cancelled' };
        setScenes([]);
        return { outcome: 'failed', error: caught instanceof Error ? caught.message : String(caught) };
      }
    // 文档按 stage 身份加载一次；场景切换不重新拉取，避免覆盖本地交互状态。
  }, [generation, projectId, recordScope, store, stageId, releaseDocumentAndAssets]);

  const host = useOpenMaicClassroomLoad({
    classroomId: stageId,
    identity: `${projectId}:${generation}:${stageId}`,
    loadDocumentAndAssets,
    releaseDocumentAndAssets,
  });
  const loadError = host.error ?? (host.notFound ? '课堂文档不存在：课件未落到当前项目。' : null);

  const current = scenes?.find((scene) => scene.id === sceneId) ?? scenes?.[0] ?? null;
  const currentBinding = bindings.find((binding) => binding.sceneId === current?.id) ?? null;

  const persistPosition = useCallback(
    async (nextSceneId: string) => {
      const lease = activeLeaseRef.current;
      if (!lease?.isCurrent()) return false;
      setPositionState('saving');
      try {
        await apiFetch('/api/maic/state', apiResponses.classroomPosition, {
          method: 'PUT',
          body: JSON.stringify({ scope: { projectId, generation }, stageId, sceneId: nextSceneId }),
        });
        return lease.applyIfCurrent(() => setPositionState('saved'));
      } catch {
        lease.applyIfCurrent(() => setPositionState('failed'));
        return false;
      }
    },
    [projectId, generation, stageId],
  );

  const selectScene = async (nextSceneId: string): Promise<void> => {
    if (positionSaving.current || !scenes?.some((scene) => scene.id === nextSceneId)) return;
    const lease = activeLeaseRef.current;
    if (!lease?.isCurrent()) return;
    positionSaving.current = true;
    setPositionError(null);
    try {
      const saved = await persistPosition(nextSceneId);
      if (!lease.isCurrent()) return;
      if (saved) {
        setSceneId(nextSceneId);
      } else {
        setPositionError('播放位置未能写入当前项目；此场景暂不能继续，请检查项目会话后重试。');
      }
    } finally {
      if (lease.isCurrent()) positionSaving.current = false;
    }
  };

  const selectRelative = (delta: number): void => {
    if (!scenes || !current) return;
    const targetIndex = scenes.findIndex((scene) => scene.id === current.id) + delta;
    const target = scenes[targetIndex];
    if (target) void selectScene(target.id);
  };

  return (
    <div className="classroom">
      <header className="shell-top">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">堂</span>
          学习空间
        </span>
        <span className="top-project">
          <strong>{lessonTitle}</strong>
          <span className="muted">
            {recordScope === 'demo' ? '演示内容，不计入正式学习进度' : '正式课时：内容来自本节冻结的证据包'}
          </span>
        </span>
        <div className="top-actions">
          <button
            type="button"
            className="btn"
            {...(teacher ? {} : { disabled: true, 'aria-disabled': true })}
            title={teacher ? '教师会话面板在右侧' : '教师运行时只在已发布且已生成课件文档的正式课时上工作'}
          >
            {teacher ? 'AI 教师：已挂接' : 'AI 教师：未挂接'}
          </button>
          <span className="pill" data-tone="info">{teacher ? 'AI 同学：在教师面板配置' : '演示课未启用 AI 同学'}</span>
          <Link className="btn btn-ghost" href="/workbench/study">
            返回工作台
          </Link>
        </div>
      </header>

      <div className="classroom-main">
        <div className="classroom-stage">
          {positionError ? <Notice tone="error" role="alert">{positionError}</Notice> : null}
          {loadError ? (
            <Notice tone="error" role="alert">
              课堂文档读取失败：{loadError}
              {!host.notFound ? <button type="button" className="btn" onClick={host.retryClassroom}>
                重试加载课堂
              </button> : <Link className="btn" href="/workbench/study">返回工作台</Link>}
            </Notice>
          ) : null}
          {host.loading && !loadError ? (
            <Notice tone="pending" role="status">
              正在加载课堂文档与资源…
            </Notice>
          ) : null}
          {host.ready && scenes && current ? (
            <>
              <div className="tabs" style={{ background: 'transparent' }}>
                {scenes.map((scene) => (
                  <button
                    key={scene.id}
                    type="button"
                    className="tab"
                    disabled={positionState === 'saving'}
                    data-current={scene.id === current.id}
                    data-scene-id={scene.id}
                    onClick={() => void selectScene(scene.id)}
                  >
                    {scene.title}
                    <span className="muted">{KIND_LABEL[scene.type] ?? scene.type}</span>
                  </button>
                ))}
              </div>
              <Stage
                scenes={scenes}
                currentSceneId={current.id}
                onPrevious={() => selectRelative(-1)}
                onNext={() => selectRelative(1)}
              >
                <SceneRenderer scene={current} bindings={bindings} scope={{ projectId, generation }} />
              </Stage>
            </>
          ) : null}
        </div>

        <aside className="classroom-roles">
          <div className="role-card">
            <div className="role-name">
              <span className="pill" data-tone="verified">来源绑定</span>
              {current ? current.title : '未选择场景'}
            </div>
            {currentBinding ? (
              <ul className="check-list">
                <li><span>知识点</span><span className="muted mono">{currentBinding.knowledgeIds.join('、') || '无'}</span></li>
                <li><span>题目</span><span className="muted mono">{currentBinding.questionId ?? '本场景不绑题'}</span></li>
                <li><span>审核</span><span className="muted">{currentBinding.reviewedBy}</span></li>
              </ul>
            ) : (
              <p className="muted">该场景没有来源绑定，不能用于教学。</p>
            )}
          </div>

          <div className="role-card">
            <div className="role-name">
              <span className="pill" data-tone={teacher ? 'verified' : 'info'}>AI 教师</span>
              {teacher ? `已挂接 · v${teacher.lessonVersion}` : '本课堂未挂接'}
            </div>
            {teacher ? (
              <ClassroomPanel
                projectId={projectId}
                generation={generation}
                lessonId={lessonId}
                lessonVersion={teacher.lessonVersion}
                stageId={teacher.stageId}
                roomId={teacher.roomId}
                sceneId={current?.id ?? ''}
                compact
                onSceneChange={(nextSceneId: string) => void selectScene(nextSceneId)}
              />
            ) : (
              <p className="role-say">
                演示课件没有课程版本与课堂会话，因此这里不挂接教师面板。
                正式课时在「课程」页审核、生成课件文档并发布后，本页会读取同一份会话队列。
              </p>
            )}
          </div>

          <div className="role-card">
            <div className="role-name">
              <span className="pill" data-tone="info">AI 同学</span>
              {teacher ? '默认关闭' : '演示课未启用'}
            </div>
            <p className="role-say">{teacher ? '可在教师面板中开启、提问或关闭。AI 同学的发言持续标明身份，不计为你的作答。' : '演示课不启用 AI 同学。测验答案与过程由你本人填写。'}</p>
          </div>
        </aside>
      </div>

      <footer className="shell-status">
        <span>
          播放位置：
          {positionState === 'saved'
            ? '已保存'
            : positionState === 'saving'
              ? '正在保存…'
              : positionState === 'failed'
                ? '本次写入失败，重启后不会恢复到此处'
                : `已恢复：${current?.title ?? '未选择场景'}`}
        </span>
        <span className="spacer" />
        <span>学习记录保存在当前项目</span>
      </footer>
    </div>
  );
};
