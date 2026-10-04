'use client';

import { apiResponses } from '@sew/study-contracts';

/**
 * 讲解卡登记与审核（TEACH-01）。
 *
 * 卡片文本必须绑定证据包内的陈述才能批准；模型现场产生的卡片默认没有来源，
 * 因此先在待核区补来源，再进入播放队列。界面不宣称「内容正确」，只显示引用可定位。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { BundleStatementDto, ExplanationCardDto } from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

const STATUS_LABEL: Record<ExplanationCardDto['status'], string> = {
  draft: '待核',
  approved: '已审核',
  rejected: '已退回',
};

const ORIGIN_LABEL: Record<ExplanationCardDto['origin'], string> = {
  teacher_authored: '教师手写',
  model_generated: '模型产生',
};

export const ExplanationCards = ({
  projectId,
  generation,
  lessonId,
  lessonVersion,
  sceneId,
  statements,
  cards,
}: {
  projectId: string;
  generation: number;
  lessonId: string;
  lessonVersion: number;
  sceneId: string;
  statements: BundleStatementDto[];
  cards: ExplanationCardDto[];
}): ReactNode => {
  const router = useRouter();
  const [text, setText] = useState('');
  const [statementIds, setStatementIds] = useState<string[]>([]);
  const [reviewNote, setReviewNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async (body: Record<string, unknown>, success: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/study/classroom', apiResponses.explanationWrite, {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, ...body }),
      });
      setText('');
      setMessage(success);
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const sceneCards = cards.filter((card) => card.sceneId === sceneId);

  return (
    <div className="card">
      <h2>讲解卡</h2>
      <p className="secondary">
        正式连续授课只播放审核通过的卡片。卡片依据必须落在本节证据包的陈述上；
        模型现场产生的内容先进待核区，补上依据并审核后才进入队列。
      </p>
      <div className="field">
        <label htmlFor="card-scene">场景编号</label>
        <input id="card-scene" value={sceneId} readOnly />
        <span className="hint">场景编号取自本节课件；正式课件文档尚未生成时由教师按备课顺序指定。</span>
      </div>
      <div className="field">
        <label htmlFor="card-text">卡片文本</label>
        <textarea
          id="card-text"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="例如：先看图像上升趋势，再回到定义里的任意 x1 < x2"
          disabled={busy}
        />
      </div>
      <div className="field">
        <label htmlFor="card-statements">依据陈述（可多选）</label>
        <select
          id="card-statements"
          multiple
          value={statementIds}
          onChange={(event) => setStatementIds([...event.target.selectedOptions].map((option) => option.value))}
          disabled={statements.length === 0 || busy}
        >
          {statements.map((statement) => (
            <option key={statement.statementId} value={statement.statementId}>
              {statement.statementId.slice(0, 12)}… · {statement.text.slice(0, 24)}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || text.trim().length < 2}
        onClick={() => void call({
          action: 'create-card',
          lessonId,
          lessonVersion,
          sceneId,
          kind: 'explain',
          text,
          statementIds,
        }, '讲解卡已登记为草案，等待审核。')}
      >
        登记讲解卡
      </button>

      {sceneCards.length === 0 ? (
        <div style={{ marginTop: 'var(--sew-space-3)' }}><Empty>该场景还没有讲解卡。</Empty></div>
      ) : (
        <ul className="check-list" style={{ marginTop: 'var(--sew-space-3)' }}>
          {sceneCards.map((card) => (
            <li key={card.explanationId}>
              <span>
                <span className="pill" data-tone={card.status === 'approved' ? 'verified' : card.status === 'draft' ? 'pending' : 'error'}>
                  {STATUS_LABEL[card.status]}
                </span>
                {' '}#{card.position} {ORIGIN_LABEL[card.origin]} · {card.text.slice(0, 40)}
              </span>
              <span className="row-inline">
                {card.status === 'draft' ? (
                  <>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void call(
                        { action: 'review-card', explanationId: card.explanationId, decision: 'approved', note: reviewNote },
                        '讲解卡已审核通过，可进入播放队列。',
                      )}
                    >
                      审核通过
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void call(
                        { action: 'review-card', explanationId: card.explanationId, decision: 'rejected', note: reviewNote },
                        '讲解卡已退回。',
                      )}
                    >
                      退回
                    </button>
                    {card.statementIds.length === 0 ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || statementIds.length === 0}
                        onClick={() => void call(
                          { action: 'edit-card', explanationId: card.explanationId, statementIds },
                          '已把当前选中的依据挂到这张待核卡片上。',
                        )}
                      >
                        用上方所选陈述补来源
                      </button>
                    ) : null}
                  </>
                ) : (
                  <span className="muted mono">{card.statementIds.length} 条依据</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="field" style={{ marginTop: 'var(--sew-space-3)' }}>
        <label htmlFor="card-note">审核备注</label>
        <input id="card-note" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="例如：与教材第 2 段一致" />
      </div>
      {message ? <Notice tone="verified">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
};
