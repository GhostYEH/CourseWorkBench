import { useState, type ReactNode } from 'react';
import {
  classroomBoardPublicContentSchema,
  type ClassroomSharedCourseDto,
  type CollabBoardContentDto,
  type CollabRoomMemberDto,
  type CollabTeachingOperation,
  type CollabTeachingStateDto,
} from '@sew/study-contracts';

export const collabSceneStatements = (
  snapshot: ClassroomSharedCourseDto | null,
  sceneId: string | null,
): ClassroomSharedCourseDto['evidence']['statements'] => {
  if (!snapshot || !sceneId) return [];
  const source = snapshot.sceneSources.find((item) => item.sceneId === sceneId);
  if (!source) return [];
  const knowledgeIds = new Set(source.knowledgeIds);
  return snapshot.evidence.statements.filter((item) => knowledgeIds.has(item.knowledgeId));
};

export const currentSceneTeaching = (
  teaching: CollabTeachingStateDto | null,
  sceneId: string | null,
): CollabTeachingStateDto | null =>
  teaching && sceneId && teaching.sceneId === sceneId ? teaching : null;

/** 已写进公共白板的内容；旧状态缺该字段时按空处理。 */
export const collabBoardContents = (
  teaching: CollabTeachingStateDto | null,
): CollabBoardContentDto[] => teaching?.board.contents ?? [];

/**
 * 把「每行一条」的简图草稿解析为公共白板内容。
 *
 * 节点行：`id | 标签`；连线行：`from -> to`（可选 `| 标签`）。
 * 任一行不合法返回 null，界面据此禁用「写入白板」，不在客户端伪造一个能过校验的形状。
 */
export const parseBoardDiagram = (
  nodesText: string,
  edgesText: string,
): {
  kind: 'diagram';
  nodes: Array<{ id: string; label: string; x: number; y: number }>;
  edges: Array<{ from: string; to: string; label?: string }>;
} | null => {
  const rows = (value: string): string[] =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  const nodes = rows(nodesText).map((line, index) => {
    const [rawId, ...rest] = line.split('|');
    const id = (rawId ?? '').trim();
    const label = rest.join('|').trim() || id;
    // 纵向均匀排布，避免所有节点重叠；坐标仅为公共白板的示意位置。
    return { id, label, x: 20, y: 20 + index * 60 };
  });
  const edges = rows(edgesText).map((line) => {
    const [pair, ...rest] = line.split('|');
    const [from, to] = (pair ?? '').split('->').map((part) => part.trim());
    const label = rest.join('|').trim();
    return label ? { from: from ?? '', to: to ?? '', label } : { from: from ?? '', to: to ?? '' };
  });
  const parsed = classroomBoardPublicContentSchema.safeParse({ kind: 'diagram', nodes, edges });
  return parsed.success && parsed.data.kind === 'diagram' ? parsed.data : null;
};

export interface CollabTeachingPanelProps {
  snapshot: ClassroomSharedCourseDto | null;
  sceneId: string | null;
  selfUid: string;
  owner: boolean;
  enabled: boolean;
  members: CollabRoomMemberDto[];
  state: CollabTeachingStateDto | null;
  onOperation: (operation: CollabTeachingOperation) => void;
}

/** Public teaching actions reference reviewed snapshot material; prose is never submitted by the UI. */
export const CollabTeachingPanel = ({
  snapshot,
  sceneId,
  selfUid,
  owner,
  enabled,
  members,
  state,
  onOperation,
}: CollabTeachingPanelProps): ReactNode => {
  const statements = collabSceneStatements(snapshot, sceneId);
  const scene = snapshot?.scenes.find((item) => item.sceneId === sceneId) ?? null;
  const elements = scene?.type === 'slide' ? scene.elements : [];
  const [statementId, setStatementId] = useState('');
  const [elementId, setElementId] = useState('');
  const [targetUid, setTargetUid] = useState('');
  const [contentKind, setContentKind] = useState<'text' | 'formula' | 'diagram'>('text');
  const [boardText, setBoardText] = useState('');
  const [boardLatex, setBoardLatex] = useState('');
  const [diagramNodes, setDiagramNodes] = useState('');
  const [diagramEdges, setDiagramEdges] = useState('');
  const statement = statements.find((item) => item.statementId === statementId) ?? statements[0];
  const element = elements.find((item) => item.elementId === elementId) ?? elements[0];
  const waiting = state?.waiting ?? null;
  const hasPendingWait = waiting !== null;
  const boardHistory = state?.board.history;
  const boardActionLimitReached = (boardHistory?.actions.length ?? 0) >= 200;
  const selfIsTarget = waiting?.targetUid === selfUid;
  const target = members.find((member) => member.uid === waiting?.targetUid);
  const possibleTargets = members.filter(
    (member) => member.uid !== selfUid && member.readiness !== 'left',
  );
  const contents = collabBoardContents(state);

  // 只构造「当前可写入」的内容：不合法时按钮禁用，绝不把半成品发给服务端。
  const pendingContent: CollabTeachingOperation | null = (() => {
    if (contentKind === 'text') {
      const parsed = classroomBoardPublicContentSchema.safeParse({
        kind: 'text',
        text: boardText.trim(),
      });
      return parsed.success
        ? { kind: 'write', statementId: statement?.statementId ?? '', content: parsed.data }
        : null;
    }
    if (contentKind === 'formula') {
      const parsed = classroomBoardPublicContentSchema.safeParse({
        kind: 'formula',
        text: boardText.trim(),
        latex: boardLatex.trim() || null,
      });
      return parsed.success
        ? { kind: 'write', statementId: statement?.statementId ?? '', content: parsed.data }
        : null;
    }
    const diagram = parseBoardDiagram(diagramNodes, diagramEdges);
    return diagram
      ? { kind: 'write', statementId: statement?.statementId ?? '', content: diagram }
      : null;
  })();

  return (
    <section className="card card-nested" data-collab-teaching>
      <h4>教师公共讲解与白板</h4>
      {owner ? (
        <div data-collab-teaching-owner-controls>
          <label>
            当前场景已审核陈述
            <select
              data-collab-teaching-statement
              value={statement?.statementId ?? ''}
              disabled={!enabled || statements.length === 0}
              onChange={(event) => setStatementId(event.target.value)}
            >
              {statements.length === 0 ? <option value="">当前场景没有关联陈述</option> : null}
              {statements.map((item) => (
                <option key={item.statementId} value={item.statementId}>
                  {item.statementId} · 知识点 {item.knowledgeId} · {item.text.slice(0, 70)}
                </option>
              ))}
            </select>
          </label>
          {statement ? (
            <p className="hint" data-collab-teaching-source={statement.statementId}>
              来源标识：
              {statement.evidence
                .map((source) => `${source.materialId}@v${source.revision}/${source.segmentId}`)
                .join('、')}
            </p>
          ) : null}
          <button
            type="button"
            className="btn"
            data-collab-teaching-speak
            disabled={!enabled || !statement || hasPendingWait}
            onClick={() => {
              if (statement) onOperation({ kind: 'speak', statementId: statement.statementId });
            }}
          >
            教师发言（已审核）
          </button>

          <div data-collab-teaching-board-composer>
            <label>
              板书类型
              <select
                data-collab-teaching-content-kind
                value={contentKind}
                disabled={!enabled}
                onChange={(event) =>
                  setContentKind(event.target.value as 'text' | 'formula' | 'diagram')
                }
              >
                <option value="text">文字</option>
                <option value="formula">公式</option>
                <option value="diagram">图形（简图）</option>
              </select>
            </label>
            {contentKind !== 'diagram' ? (
              <label>
                {contentKind === 'formula' ? '公式（可读文本）' : '板书文字'}
                <textarea
                  data-collab-teaching-board-text
                  value={boardText}
                  maxLength={4000}
                  onChange={(event) => setBoardText(event.target.value)}
                />
              </label>
            ) : null}
            {contentKind === 'formula' ? (
              <label>
                LaTeX 排版源码（可选）
                <input
                  data-collab-teaching-board-latex
                  className="mono"
                  value={boardLatex}
                  maxLength={2000}
                  onChange={(event) => setBoardLatex(event.target.value)}
                />
              </label>
            ) : null}
            {contentKind === 'diagram' ? (
              <>
                <label>
                  {'节点（每行 id | 标签）'}
                  <textarea
                    data-collab-teaching-board-nodes
                    value={diagramNodes}
                    onChange={(event) => setDiagramNodes(event.target.value)}
                  />
                </label>
                <label>
                  {'连线（每行 起点 -> 终点 | 标签）'}
                  <textarea
                    data-collab-teaching-board-edges
                    value={diagramEdges}
                    onChange={(event) => setDiagramEdges(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            <button
              type="button"
              className="btn"
              data-collab-teaching-write
              disabled={
                !enabled ||
                !statement ||
                hasPendingWait ||
                boardActionLimitReached ||
                !pendingContent
              }
              onClick={() => {
                if (pendingContent) onOperation(pendingContent);
              }}
            >
              写入公共白板
            </button>
            <p className="hint">
              板书内容必须挂在当前场景的已审核陈述上；文字/公式不接受 HTML 或脚本。
            </p>
          </div>

          <label>
            当前幻灯片元素
            <select
              data-collab-teaching-element
              value={element?.elementId ?? ''}
              disabled={!enabled || elements.length === 0}
              onChange={(event) => setElementId(event.target.value)}
            >
              {elements.length === 0 ? <option value="">当前场景没有白板元素</option> : null}
              {elements.map((item) => (
                <option key={item.elementId} value={item.elementId}>
                  {item.elementId} · {item.text.slice(0, 70)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            data-collab-teaching-focus
            disabled={!enabled || !element || hasPendingWait || boardActionLimitReached}
            onClick={() => {
              if (element) onOperation({ kind: 'focus', elementId: element.elementId });
            }}
          >
            聚焦元素
          </button>
          <button
            type="button"
            className="btn"
            data-collab-teaching-laser
            disabled={!enabled || !element || hasPendingWait || boardActionLimitReached}
            onClick={() => {
              if (element) onOperation({ kind: 'laser', elementId: element.elementId });
            }}
          >
            激光指示元素
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-collab-teaching-clear-board
            disabled={!enabled || boardActionLimitReached}
            onClick={() => onOperation({ kind: 'clear-board' })}
          >
            清除白板标记
          </button>
          {hasPendingWait ? (
            <p className="hint">等待期间暂停教师发言、板书、聚焦与激光指示；房主可取消等待。</p>
          ) : null}
          {boardActionLimitReached ? (
            <p className="hint" data-collab-board-history-limit>
              当前场景白板动作额度已满（200 项）；可撤销或重放已有动作。
            </p>
          ) : null}

          <label>
            等待同学 UID
            <select
              data-collab-teaching-target
              value={targetUid}
              disabled={!enabled || waiting !== null || possibleTargets.length === 0}
              onChange={(event) => setTargetUid(event.target.value)}
            >
              <option value="">选择同学</option>
              {possibleTargets.map((member) => (
                <option key={member.uid} value={member.uid}>
                  {member.uid}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            data-collab-teaching-wait
            disabled={
              !enabled ||
              waiting !== null ||
              !possibleTargets.some((item) => item.uid === targetUid)
            }
            onClick={() => onOperation({ kind: 'wait', targetUid })}
          >
            等待同学确认
          </button>
        </div>
      ) : null}

      {waiting ? (
        <div data-collab-teaching-waiting={waiting.waitEventId} aria-live="polite">
          <p>
            正在等待 {waiting.targetUid} 确认
            {target?.readiness === 'left' ? '（该成员已离开）' : ''}
            {waiting.acknowledged ? ' · 已确认' : ' · 尚未确认'}
          </p>
          {selfIsTarget && !waiting.acknowledged ? (
            <button
              type="button"
              className="btn"
              data-collab-teaching-acknowledge
              disabled={!enabled}
              onClick={() => onOperation({ kind: 'acknowledge', waitEventId: waiting.waitEventId })}
            >
              我已确认
            </button>
          ) : null}
          {owner && waiting.acknowledged ? (
            <button
              type="button"
              className="btn"
              data-collab-teaching-release-wait
              disabled={!enabled}
              onClick={() =>
                onOperation({ kind: 'release-wait', waitEventId: waiting.waitEventId })
              }
            >
              继续课堂（房主）
            </button>
          ) : null}
          {owner ? (
            <button
              type="button"
              className="btn btn-ghost"
              data-collab-teaching-cancel-wait
              disabled={!enabled}
              onClick={() => onOperation({ kind: 'cancel-wait', waitEventId: waiting.waitEventId })}
            >
              取消等待
            </button>
          ) : null}
        </div>
      ) : null}

      {contents.length > 0 ? (
        <section data-collab-board-contents aria-label="公共白板已写内容">
          <h5>公共白板内容</h5>
          <ul>
            {contents.map((item) => (
              <li key={item.eventId} data-collab-board-content={item.eventId}>
                <span className="hint mono">来源 {item.statementId}</span>
                {item.content.kind === 'text' ? (
                  <p style={{ whiteSpace: 'pre-wrap' }}>{item.content.text}</p>
                ) : item.content.kind === 'formula' ? (
                  <p style={{ whiteSpace: 'pre-wrap' }}>
                    {item.content.text}
                    {item.content.latex ? (
                      <span className="mono"> · {item.content.latex}</span>
                    ) : null}
                  </p>
                ) : (
                  <p>
                    简图：{item.content.nodes.map((node) => node.label).join('、')}（
                    {item.content.edges.length} 条连线）
                  </p>
                )}
                {owner ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-collab-board-erase={item.eventId}
                    disabled={!enabled || hasPendingWait || boardActionLimitReached}
                    onClick={() => onOperation({ kind: 'erase', actionEventId: item.eventId })}
                  >
                    擦除此内容
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {boardHistory ? (
        <section data-collab-board-history aria-label="公共白板动作历史">
          <h5>公共白板动作历史</h5>
          <p className="hint">
            场景基线：聚焦 {boardHistory.baseline.focusElementId ?? '无'} · 激光{' '}
            {boardHistory.baseline.laserElementId ?? '无'}
          </p>
          {boardHistory.actions.length > 0 ? (
            <ol>
              {boardHistory.actions.map((action) => (
                <li
                  key={action.eventId}
                  data-collab-board-action={action.eventId}
                  data-collab-board-action-applied={action.applied}
                >
                  <span>
                    #{action.seq} {action.kind === 'focus' ? '聚焦' : null}
                    {action.kind === 'laser' ? '激光指示' : null}
                    {action.kind === 'clear-board' ? '清除白板标记' : null}
                    {action.kind === 'write' ? '板书' : null}
                    {action.kind === 'erase' ? '擦除' : null}
                    {action.elementId ? ` · ${action.elementId}` : ''}
                    {action.kind === 'write' && action.content ? ` · ${action.content.kind}` : ''}
                    {action.targetEventId ? ` · 目标 ${action.targetEventId}` : ''}
                    {action.applied ? ' · 已应用' : ' · 已撤销'}
                  </span>
                  {owner ? (
                    <>
                      {action.applied ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          data-collab-board-undo={action.eventId}
                          disabled={!enabled || hasPendingWait}
                          onClick={() =>
                            onOperation({ kind: 'undo-board', actionEventId: action.eventId })
                          }
                        >
                          撤销此动作
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          data-collab-board-replay={action.eventId}
                          disabled={!enabled || hasPendingWait}
                          onClick={() =>
                            onOperation({ kind: 'replay-board', actionEventId: action.eventId })
                          }
                        >
                          重放此动作
                        </button>
                      )}
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">当前场景还没有白板动作。</p>
          )}
        </section>
      ) : null}

      {state && state.outputs.length > 0 ? (
        <ol data-collab-teaching-outputs aria-live="polite">
          {state.outputs.map((output) => {
            const source = snapshot?.evidence.statements.find(
              (item) => item.statementId === output.statementId,
            );
            return (
              <li key={output.eventId} data-collab-teaching-output={output.seq}>
                <strong>教师（已审核课程）</strong>：{output.body}
                {output.conditions ? <span> 适用条件：{output.conditions}</span> : null}
                <span className="hint">
                  {' '}
                  来源 {output.statementId}
                  {source
                    ? ` · ${source.evidence
                        .map((item) => `${item.materialId}@v${item.revision}/${item.segmentId}`)
                        .join('、')}`
                    : ''}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted" data-collab-teaching-empty>
          当前场景还没有教师公共发言。
        </p>
      )}
    </section>
  );
};
