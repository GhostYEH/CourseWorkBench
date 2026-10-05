'use client';

import { useState } from 'react';
import type { EvidenceBundleDto, LessonVersionDto } from '@sew/study-contracts';
import { defaultRevisionTitle, hasLessonRevisionChanges } from './lesson-scene-revision-state';

/**
 * 逐场景改写：以某个已冻结版本为基线派生**新的草案版本**。
 *
 * 陈述正文来自已审核知识与冻结证据包，界面不能就地改写；这里只决定新版本包含哪些场景，
 * 因此新版本必须重新走人工审核与发布，旧已发布版本在替换前保持原样。
 */
export const LessonSceneRevision = ({
  bundle,
  lesson,
  busy,
  onRevise,
}: {
  bundle: EvidenceBundleDto;
  lesson: LessonVersionDto;
  busy: boolean;
  onRevise: (title: string, statementIds: string[]) => void;
}) => {
  const [title, setTitle] = useState(defaultRevisionTitle(lesson.title));
  const [selected, setSelected] = useState<string[]>(lesson.statementIds);
  const scenes = bundle.statements;
  const toggle = (statementId: string): void =>
    setSelected((current) =>
      current.includes(statementId)
        ? current.filter((item) => item !== statementId)
        : [...current, statementId],
    );
  const changed = hasLessonRevisionChanges(lesson.title, lesson.statementIds, title, selected);

  return (
    <details className="card">
      <summary>逐场景改写（派生新草案版本）</summary>
      <p className="muted">
        基线：v{lesson.version}（{lesson.statementIds.length} 个场景）。勾选决定新版本包含哪些场景，
        正文仍来自已审核知识；新版本需重新审核后才能发布。
      </p>
      <label className="field">
        <span>新草案标题</span>
        <input
          type="text"
          value={title}
          maxLength={120}
          disabled={busy}
          data-revise-title
          onChange={(event) => setTitle(event.target.value)}
        />
        <span className="muted">修改标题或场景选择后可派生；默认「（改写）」后缀不算改动。</span>
      </label>
      {scenes.length === 0 ? (
        <p className="muted">该证据包没有可归入本课程的场景，请先在「证据包」里选入已审核陈述。</p>
      ) : (
        <ul className="check-list">
          {scenes.map((statement, index) => (
            <li key={statement.statementId}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(statement.statementId)}
                  disabled={busy}
                  data-revise-scene={statement.statementId}
                  onChange={() => toggle(statement.statementId)}
                />
                <span>
                  场景 {index + 1}：{statement.text.slice(0, 40)}
                  {statement.text.length > 40 ? '…' : ''}
                </span>
                <span className="muted mono">
                  {lesson.statementIds.includes(statement.statementId) ? '基线已有' : '本版本新增'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="row-inline">
        <button
          type="button"
          className="btn"
          disabled={busy || !changed || title.trim().length < 2 || selected.length === 0}
          data-revise-submit
          onClick={() => onRevise(title.trim(), selected)}
        >
          {busy ? '正在派生…' : `派生新草案（${selected.length} 个场景）`}
        </button>
        {selected.length === 0 ? <span className="muted">至少保留一个场景。</span> : null}
      </div>
    </details>
  );
};
