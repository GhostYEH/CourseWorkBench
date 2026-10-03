'use client';

import { Notice } from './ui';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PreferencesDto, TeachingPreferenceDto } from '@sew/study-contracts';
import { apiFetch, applyThemeToDocument, describeApiError } from '../lib/client';

const PRESET_LABEL: Record<PreferencesDto['theme'], string> = {
  paper: '纸色',
  light: '浅色',
  dark: '暗色',
  system: '跟随系统',
};

const ACCENT_LABEL: Record<PreferencesDto['accentPreset'], string> = {
  cinnabar: '朱砂',
  teal: '深青',
  indigo: '靛蓝',
};

/** 外观与阅读：先预览，点击应用后由服务持久化；取消恢复进入设置前的配置。 */
export const AppearanceSettings = ({ initial }: { initial: PreferencesDto }) => {
  const router = useRouter();
  const [draft, setDraft] = useState<PreferencesDto>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = <K extends keyof PreferencesDto>(key: K, value: PreferencesDto[K]) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    applyThemeToDocument(next);
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch<{ appearance: PreferencesDto }>('/api/study/preferences', {
        method: 'PUT',
        body: JSON.stringify({ appearance: draft }),
      });
      setDraft(data.appearance);
      setMessage('外观设置已保存。主题不会改变课程内容与掌握记录。');
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setDraft(initial);
    applyThemeToDocument(initial);
    setMessage('已恢复进入设置前的配置（尚未保存）。');
  };

  return (
    <div className="card">
      <h2>外观与阅读</h2>
      <div className="row-inline">
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="theme">主题</label>
          <select id="theme" value={draft.theme} onChange={(event) => update('theme', event.target.value as PreferencesDto['theme'])}>
            {(Object.keys(PRESET_LABEL) as PreferencesDto['theme'][]).map((key) => (
              <option key={key} value={key}>
                {PRESET_LABEL[key]}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="accent">强调色</label>
          <select
            id="accent"
            value={draft.accentPreset}
            onChange={(event) => update('accentPreset', event.target.value as PreferencesDto['accentPreset'])}
          >
            {(Object.keys(ACCENT_LABEL) as PreferencesDto['accentPreset'][]).map((key) => (
              <option key={key} value={key}>
                {ACCENT_LABEL[key]}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="density">密度</label>
          <select
            id="density"
            value={draft.density}
            onChange={(event) => update('density', event.target.value as PreferencesDto['density'])}
          >
            <option value="standard">标准</option>
            <option value="compact">紧凑</option>
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="reading-font">正文字体</label>
          <select
            id="reading-font"
            value={draft.readingFont}
            onChange={(event) => update('readingFont', event.target.value as PreferencesDto['readingFont'])}
          >
            <option value="system-sans">系统无衬线</option>
            <option value="system-serif">系统衬线</option>
          </select>
        </div>
      </div>

      <div className="row-inline">
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor="font-size">正文字号：{draft.readingFontSizePx}px（16—24）</label>
          <input
            id="font-size"
            type="range"
            min={16}
            max={24}
            value={draft.readingFontSizePx}
            onChange={(event) => update('readingFontSizePx', Number(event.target.value))}
          />
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor="line-height">行距：{draft.readingLineHeight}（1.5—2.0）</label>
          <input
            id="line-height"
            type="range"
            min={1.5}
            max={2}
            step={0.05}
            value={draft.readingLineHeight}
            onChange={(event) => update('readingLineHeight', Number(event.target.value))}
          />
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor="max-width">正文宽度：{draft.readingMaxWidthPx}px（640—920）</label>
          <input
            id="max-width"
            type="range"
            min={640}
            max={920}
            step={20}
            value={draft.readingMaxWidthPx}
            onChange={(event) => update('readingMaxWidthPx', Number(event.target.value))}
          />
        </div>
      </div>

      <h3>样文预览</h3>
      <div className="reading" style={{ background: 'var(--sew-surface-document)', padding: 'var(--sew-space-4)', borderRadius: 'var(--sew-card-radius)' }}>
        <p>
          设函数 f(x) 的定义域为 I，如果对于定义域 I 内某个区间 D 上的任意两个自变量的值 x1、x2，
          当 x1 &lt; x2 时，都有 f(x1) &lt; f(x2)，那么就说函数 f(x) 在区间 D 上是增函数。
        </p>
        <p className="muted" style={{ fontSize: '12px' }}>
          来源：人教版必修一 第三章 · 材料 r1 · 段落 S002
        </p>
      </div>

      <div className="row-inline" style={{ marginTop: 'var(--sew-space-4)' }}>
        <button type="button" className="btn btn-primary" onClick={apply} disabled={busy}>
          应用并保存
        </button>
        <button type="button" className="btn" onClick={reset} disabled={busy}>
          取消（恢复进入设置前的配置）
        </button>
      </div>
      {message ? (
        <Notice tone="verified" style={{ marginTop: 'var(--sew-space-3)' }}>
          {message}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" style={{ marginTop: 'var(--sew-space-3)' }}>
          {error}
        </Notice>
      ) : null}
    </div>
  );
};

/** 教学表达属于项目配置，与外观分开；运行期间修改「下次任务生效」。 */
export const TeachingSettings = ({
  initial,
  projectId,
  generation,
}: {
  initial: TeachingPreferenceDto;
  projectId: string;
  generation: number;
}) => {
  const router = useRouter();
  const [draft, setDraft] = useState<TeachingPreferenceDto>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = <K extends keyof TeachingPreferenceDto>(key: K, value: TeachingPreferenceDto[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      const data = await apiFetch<{ teaching: TeachingPreferenceDto }>('/api/study/preferences', {
        method: 'PUT',
        // 教学表达是项目级事实：显式绑定项目与打开代次，过期代次由服务拒绝。
        body: JSON.stringify({ scope: { projectId, generation }, teaching: draft }),
      });
      setDraft(data.teaching);
      setMessage('教学表达设置已保存。已发布的课程保持原版本，重新生成进入新的草案与审核流程。');
      router.refresh();
    } catch (caught) {
      setMessage(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>教学表达</h2>
      <p className="secondary">
        教学表达只改变讲解方式，不改变知识事实，也不能授予工具权限或写入事实。
        任何表达偏好都不能臆造出处、伪装真题或授予掌握状态。
      </p>
      <div className="row-inline">
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="learning-mode">学习模式</label>
          <select
            id="learning-mode"
            value={draft.learningMode}
            onChange={(event) => update('learningMode', event.target.value as TeachingPreferenceDto['learningMode'])}
          >
            <option value="beginner">零基础</option>
            <option value="review">复习</option>
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="explanation">解释方式</label>
          <select
            id="explanation"
            value={draft.explanation}
            onChange={(event) => update('explanation', event.target.value as TeachingPreferenceDto['explanation'])}
          >
            <option value="intuitive">直观示例</option>
            <option value="rigorous">逐步严谨</option>
            <option value="concise">简洁回顾</option>
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="hint-depth">提示深度</label>
          <select
            id="hint-depth"
            value={draft.hintDepth}
            onChange={(event) => update('hintDepth', event.target.value as TeachingPreferenceDto['hintDepth'])}
          >
            <option value="light">轻提示</option>
            <option value="stepwise">分步引导</option>
            <option value="full">完整解析</option>
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="exercise-balance">例题与独练配比</label>
          <select
            id="exercise-balance"
            value={draft.exerciseBalance}
            onChange={(event) =>
              update('exerciseBalance', event.target.value as TeachingPreferenceDto['exerciseBalance'])
            }
          >
            <option value="explanation-first">讲解优先</option>
            <option value="balanced">均衡</option>
            <option value="practice-first">练习优先</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="extra-preference">额外表达偏好（最多 500 字，低优先级）</label>
        <textarea
          id="extra-preference"
          maxLength={500}
          value={draft.extraPreference}
          onChange={(event) => update('extraPreference', event.target.value)}
        />
      </div>
      <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
        保存教学表达
      </button>
      {message ? (
        <Notice style={{ marginTop: 'var(--sew-space-3)' }}>
          {message}
        </Notice>
      ) : null}
      <p className="muted mono">
        project {projectId} · generation {generation}
      </p>
    </div>
  );
};
