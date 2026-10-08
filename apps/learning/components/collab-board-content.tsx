import { useId, type ReactNode } from 'react';
import type { CollabBoardContentDto } from '@sew/study-contracts';

/** Render the persisted public-board content identically in both room consumers. */
export const CollabBoardContent = ({
  content,
  label = '公共板书内容',
}: {
  content: CollabBoardContentDto['content'];
  label?: string;
}): ReactNode => {
  const arrowMarkerId = `collab-board-arrow-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  if (content.kind === 'text') {
    return <p style={{ whiteSpace: 'pre-wrap' }}>{content.text}</p>;
  }
  if (content.kind === 'formula') {
    return (
      <div data-collab-board-formula aria-label={label}>
        <p style={{ whiteSpace: 'pre-wrap' }}>{content.text}</p>
        {content.latex ? (
          <p className="mono" data-collab-board-latex>
            {content.latex}
          </p>
        ) : null}
      </div>
    );
  }

  const nodesById = new Map(content.nodes.map((node) => [node.id, node]));
  const validEdges = content.edges.flatMap((edge, index) => {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    return from && to
      ? [{ edge, from, to, index, length: Math.hypot(to.x - from.x, to.y - from.y) }]
      : [];
  });
  const danglingEdges = content.edges.filter(
    (edge) => !nodesById.has(edge.from) || !nodesById.has(edge.to),
  );
  const nodeRadii = new Map(content.nodes.map((node) => [node.id, 28]));
  validEdges.forEach(({ edge, length }) => {
    if (length <= 0 || edge.from === edge.to) return;
    // Keep short directed edges visible by shrinking both connected circles to
    // one fifth of their nearest positive edge distance.
    const radius = Math.min(28, length * 0.2);
    nodeRadii.set(edge.from, Math.min(nodeRadii.get(edge.from) ?? 28, radius));
    nodeRadii.set(edge.to, Math.min(nodeRadii.get(edge.to) ?? 28, radius));
  });

  return (
    <figure data-collab-board-diagram aria-label={label}>
      <svg
        viewBox="0 0 1000 1000"
        role="img"
        aria-label={`简图，${content.nodes.length} 个节点，${validEdges.length} 条有效连线`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', maxWidth: 560, minHeight: 200, overflow: 'visible' }}
      >
        <defs>
          <marker
            id={arrowMarkerId}
            markerWidth="5"
            markerHeight="5"
            refX="4"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L5,4 L0,8 z" fill="currentColor" />
          </marker>
        </defs>
        {validEdges.map(({ edge, from, to, index }) => {
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const length = Math.hypot(dx, dy);
          const fromRadius = nodeRadii.get(from.id) ?? 28;
          const toRadius = nodeRadii.get(to.id) ?? 28;
          const startX = length > 0 ? from.x + (dx / length) * fromRadius : from.x;
          const startY = length > 0 ? from.y + (dy / length) * fromRadius : from.y;
          const endX = length > 0 ? to.x - (dx / length) * toRadius : to.x;
          const endY = length > 0 ? to.y - (dy / length) * toRadius : to.y;
          const midpointX = (from.x + to.x) / 2;
          const midpointY = (from.y + to.y) / 2;
          if (length === 0 && edge.from === edge.to) {
            const nodeRadius = fromRadius;
            return (
              <g
                key={`${edge.from}-${edge.to}-${index}`}
                data-collab-board-edge={`${edge.from}->${edge.to}`}
                data-collab-board-self-loop
              >
                <path
                  d={`M ${from.x + nodeRadius} ${from.y} C ${from.x + nodeRadius + 40} ${from.y - 60}, ${from.x - nodeRadius - 40} ${from.y - 60}, ${from.x - nodeRadius} ${from.y}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  markerEnd={`url(#${arrowMarkerId})`}
                  aria-label={`${from.label} 自环${edge.label ? `：${edge.label}` : ''}`}
                />
                {edge.label ? (
                  <text
                    x={midpointX}
                    y={midpointY - 60}
                    textAnchor="middle"
                    data-collab-board-edge-label
                  >
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          }
          if (length === 0) {
            return (
              <g
                key={`${edge.from}-${edge.to}-${index}`}
                data-collab-board-edge={`${edge.from}->${edge.to}`}
                data-collab-board-overlap
              />
            );
          }
          return (
            <g
              key={`${edge.from}-${edge.to}-${index}`}
              data-collab-board-edge={`${edge.from}->${edge.to}`}
            >
              <line
                x1={startX}
                y1={startY}
                x2={endX}
                y2={endY}
                data-from-node={edge.from}
                data-to-node={edge.to}
                stroke="currentColor"
                strokeWidth="3"
                markerEnd={`url(#${arrowMarkerId})`}
                aria-label={`${from.label} 指向 ${to.label}${edge.label ? `：${edge.label}` : ''}`}
              />
              {edge.label ? (
                <text
                  x={midpointX}
                  y={midpointY - 10}
                  textAnchor="middle"
                  data-collab-board-edge-label
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {content.nodes.map((node) => (
          <g key={node.id} data-collab-board-node={node.id}>
            <circle
              cx={node.x}
              cy={node.y}
              r={nodeRadii.get(node.id) ?? 28}
              fill="var(--card-bg, white)"
              stroke="currentColor"
              strokeWidth="3"
            />
            <text x={node.x} y={node.y + 50} textAnchor="middle">
              {node.label}
            </text>
          </g>
        ))}
      </svg>
      <figcaption>
        <span className="sr-only">节点与关系：</span>
        <ul aria-label="简图关系文字说明" data-collab-board-relations>
          {validEdges.map(({ edge, from, to, index }) => (
            <li
              key={`${edge.from}-${edge.to}-${index}`}
              data-collab-board-overlap-relation={
                from.x === to.x && from.y === to.y && edge.from !== edge.to ? 'true' : undefined
              }
            >
              {from.x === to.x && from.y === to.y && edge.from !== edge.to
                ? `节点坐标重合，未绘制连线：`
                : null}
              {from.label} → {to.label}
              {edge.label ? `：${edge.label}` : ''}
            </li>
          ))}
          {danglingEdges.map((edge, index) => (
            <li key={`dangling-${index}`} data-collab-board-dangling-edge>
              无法呈现连接：
              {nodesById.has(edge.from)
                ? nodesById.get(edge.from)?.label
                : `未知节点 ${edge.from}`}{' '}
              → {nodesById.has(edge.to) ? nodesById.get(edge.to)?.label : `未知节点 ${edge.to}`}
              {edge.label ? `：${edge.label}` : ''}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
};
