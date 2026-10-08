import { useEffect, useState, type ReactNode } from 'react';
import {
  COLLAB_TEACHING_AI_SENDER_LABEL,
  type ClassroomSharedCourseDto,
  type CollabOnlineCommand,
  type CollabTeachingAiReadViewDto,
} from '@sew/study-contracts';
import { collabSceneStatements } from './collab-teaching-panel';

type Operation = Extract<CollabOnlineCommand, { action: 'teaching-ai' }>['operation'];
type Candidate = NonNullable<CollabTeachingAiReadViewDto['state']>['candidates'][number];

const ownerGateBlockedReasons = new Set([
  'not_room_member',
  'collab_room_not_active',
  'collab_ai_owner_required',
  'collab_ai_waiting_learner',
]);

const sourceStatement = (snapshot: ClassroomSharedCourseDto | null, statementId: string) =>
  snapshot?.evidence.statements.find((item) => item.statementId === statementId) ?? null;

const candidateLabel = (candidate: Candidate): string =>
  candidate.senderType === 'teacher_ai'
    ? COLLAB_TEACHING_AI_SENDER_LABEL.teacher_ai
    : `${COLLAB_TEACHING_AI_SENDER_LABEL.peer_ai} · ${candidate.peerName ?? candidate.roleProfileId ?? ''}`;

/** The public projection is the sole transcript source for both owner and peer. */
export const CollabTeachingAiPanel = ({
  view,
  snapshot,
  selfUid,
  enabled,
  busy = false,
  peerProfiles,
  onOperation,
}: {
  view: CollabTeachingAiReadViewDto | null;
  snapshot: ClassroomSharedCourseDto | null;
  selfUid: string | null;
  enabled: boolean;
  busy?: boolean;
  peerProfiles: Array<{ roleProfileId: string; name: string }>;
  onOperation: (operation: Operation) => void;
}): ReactNode => {
  const [anchorStatementId, setAnchorStatementId] = useState('');
  const [roleProfileId, setRoleProfileId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [semanticReviewedFor, setSemanticReviewedFor] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  useEffect(() => {
    setSemanticReviewedFor(null);
    setReviewNote('');
  }, [view?.sceneId]);
  const owner = Boolean(view && view.state !== null && selfUid);
  const statements = collabSceneStatements(snapshot, view?.sceneId ?? null);
  const statement =
    statements.find((item) => item.statementId === anchorStatementId) ?? statements[0];
  const selectedProfile = peerProfiles.find((item) => item.roleProfileId === roleProfileId);
  const candidates = owner ? (view?.state?.candidates ?? []) : [];
  const selectedCandidate =
    candidates.find((item) => item.candidateId === candidateId) ?? candidates[0];
  const semanticReviewed = Boolean(
    selectedCandidate &&
    semanticReviewedFor === `${view?.sceneId ?? ''}:${selectedCandidate.candidateId}`,
  );
  const blockedByAuthorityOrWait = !view || ownerGateBlockedReasons.has(view.gate.reason ?? '');
  const canReview = owner && enabled && !busy && !blockedByAuthorityOrWait;
  const canBroadcast = canReview && view?.gate.reason !== 'collab_ai_output_limit';
  const canGenerate =
    owner && enabled && !busy && Boolean(view?.gate.canGenerate) && Boolean(statement);
  const publicOutputs = view?.publicOutputs ?? [];
  const instructionValue = instruction.trim();
  const instructionField = instructionValue ? { instruction: instructionValue } : {};

  const submitReview = (candidate: Candidate, decision: 'approved' | 'rejected'): void => {
    if (!canReview || !semanticReviewed || candidate.status !== 'pending') return;
    onOperation({
      kind: 'review-ai-candidate',
      candidateId: candidate.candidateId,
      decision,
      note: reviewNote.trim(),
      semanticReviewed: true,
    });
  };

  return (
    <section className="card card-nested" data-collab-teaching-ai>
      <h4>生成式教师与 AI 同学</h4>
      <section data-collab-teaching-ai-public aria-label="AI 公共发言">
        <h5>AI 公共讨论</h5>
        {publicOutputs.length > 0 ? (
          <ol>
            {publicOutputs.map((item) => {
              const anchor = sourceStatement(snapshot, item.anchorStatementId);
              return (
                <li key={item.eventId} data-collab-teaching-ai-output={item.eventId}>
                  <strong>
                    {item.aiLabel} · {item.displayName ?? 'AI 发言'}
                  </strong>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{item.body}</p>
                  <p className="hint">
                    来源陈述 {item.anchorStatementId}
                    {anchor ? ` · ${anchor.text}` : ''}
                  </p>
                  {item.conditions ? <p className="hint">适用条件：{item.conditions}</p> : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="hint">当前场景还没有已审核并播报的 AI 内容。</p>
        )}
      </section>

      {owner ? (
        <div data-collab-teaching-ai-owner>
          <h5>生成新候选</h5>
          <label>
            当前场景依据陈述
            <select
              data-collab-teaching-ai-anchor
              value={statement?.statementId ?? ''}
              disabled={!enabled || busy || statements.length === 0}
              onChange={(event) => setAnchorStatementId(event.target.value)}
            >
              {statements.length === 0 ? <option value="">当前场景没有已审核陈述</option> : null}
              {statements.map((item) => (
                <option key={item.statementId} value={item.statementId}>
                  {item.statementId} · {item.text.slice(0, 70)}
                </option>
              ))}
            </select>
          </label>
          {statement ? (
            <p className="hint" data-collab-teaching-ai-anchor-text={statement.statementId}>
              锚点陈述：{statement.text}
              {statement.conditions ? ` · 条件：${statement.conditions}` : ''}
            </p>
          ) : null}
          <label>
            生成指引（可选）
            <textarea
              data-collab-teaching-ai-instruction
              value={instruction}
              maxLength={500}
              disabled={!enabled || busy}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            data-collab-teaching-ai-generate-teacher
            disabled={!canGenerate}
            onClick={() => {
              if (!canGenerate || !statement) return;
              onOperation({
                kind: 'generate-teacher-explanation',
                anchorStatementId: statement.statementId,
                ...instructionField,
              });
            }}
          >
            生成教师讲解候选
          </button>
          <label>
            AI 同学角色
            <select
              data-collab-teaching-ai-peer-profile
              value={roleProfileId}
              disabled={!enabled || busy || peerProfiles.length === 0}
              onChange={(event) => setRoleProfileId(event.target.value)}
            >
              <option value="">选择 AI 同学</option>
              {peerProfiles.map((profile) => (
                <option key={profile.roleProfileId} value={profile.roleProfileId}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            data-collab-teaching-ai-generate-peer
            disabled={!canGenerate || !selectedProfile}
            onClick={() => {
              if (!canGenerate || !statement || !selectedProfile) return;
              onOperation({
                kind: 'generate-peer-utterance',
                roleProfileId: selectedProfile.roleProfileId,
                peerName: selectedProfile.name,
                anchorStatementId: statement.statementId,
                ...instructionField,
              });
            }}
          >
            生成 AI 同学发言候选
          </button>

          <section data-collab-teaching-ai-candidates aria-label="AI 待审核候选">
            <h5>待审核候选</h5>
            {candidates.length === 0 ? <p className="hint">暂无模型候选。</p> : null}
            {candidates.length > 0 ? (
              <label>
                当前候选
                <select
                  data-collab-teaching-ai-candidate-select
                  value={selectedCandidate?.candidateId ?? ''}
                  disabled={!enabled || busy}
                  onChange={(event) => {
                    setCandidateId(event.target.value);
                    setSemanticReviewedFor(null);
                    setReviewNote('');
                  }}
                >
                  {candidates.map((candidate) => (
                    <option key={candidate.candidateId} value={candidate.candidateId}>
                      {candidateLabel(candidate)} · {candidate.status}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {candidates.map((candidate) => {
              const anchor = sourceStatement(snapshot, candidate.anchorStatementId);
              const selected = selectedCandidate?.candidateId === candidate.candidateId;
              return (
                <article
                  key={candidate.candidateId}
                  data-collab-teaching-ai-candidate={candidate.candidateId}
                >
                  <h6>
                    {candidateLabel(candidate)} ·{' '}
                    {candidate.status === 'pending'
                      ? '待审核'
                      : candidate.status === 'approved'
                        ? '已批准'
                        : '已拒绝'}
                  </h6>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{candidate.body}</p>
                  <p className="hint">
                    来源陈述 {candidate.anchorStatementId}
                    {anchor ? ` · ${anchor.text}` : ''}
                  </p>
                  {anchor?.conditions ? (
                    <p className="hint">适用条件：{anchor.conditions}</p>
                  ) : null}
                  <p className="hint">
                    模型：{candidate.model} · 创建于 {candidate.createdAt}
                  </p>
                  {candidate.status === 'pending' && selected ? (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          data-collab-teaching-ai-semantic-reviewed={candidate.candidateId}
                          checked={semanticReviewed}
                          disabled={!canReview}
                          onChange={(event) =>
                            setSemanticReviewedFor(
                              event.target.checked
                                ? `${view?.sceneId ?? ''}:${candidate.candidateId}`
                                : null,
                            )
                          }
                        />
                        我已核对这条 AI 候选的事实、来源和适用条件
                      </label>
                      <label>
                        审核备注（可选）
                        <input
                          data-collab-teaching-ai-review-note={candidate.candidateId}
                          value={reviewNote}
                          maxLength={500}
                          disabled={!canReview}
                          onChange={(event) => setReviewNote(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn"
                        data-collab-teaching-ai-approve={candidate.candidateId}
                        disabled={!canReview || !semanticReviewed}
                        onClick={() => submitReview(candidate, 'approved')}
                      >
                        批准候选
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        data-collab-teaching-ai-reject={candidate.candidateId}
                        disabled={!canReview || !semanticReviewed}
                        onClick={() => submitReview(candidate, 'rejected')}
                      >
                        拒绝候选
                      </button>
                    </>
                  ) : null}
                  {candidate.status === 'approved' ? (
                    <button
                      type="button"
                      className="btn"
                      data-collab-teaching-ai-broadcast={candidate.candidateId}
                      disabled={!canBroadcast}
                      onClick={() => {
                        if (canBroadcast)
                          onOperation({
                            kind: 'broadcast-ai-candidate',
                            candidateId: candidate.candidateId,
                          });
                      }}
                    >
                      播报到 AI 公共讨论
                    </button>
                  ) : null}
                  {candidate.reviewNote ? (
                    <p className="hint">审核备注：{candidate.reviewNote}</p>
                  ) : null}
                </article>
              );
            })}
          </section>
        </div>
      ) : null}
    </section>
  );
};
