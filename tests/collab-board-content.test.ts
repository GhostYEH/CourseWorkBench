import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { CollabBoardContentDto } from '@sew/study-contracts';
import { CollabBoardContent } from '../apps/learning/components/collab-board-content';

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const { createElement } = require('react') as {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown;
};

describe('共同白板内容呈现', () => {
  it('把已知端点连成有向 SVG 线，并同时提供可访问的关系文字', () => {
    const content: CollabBoardContentDto['content'] = {
      kind: 'diagram',
      nodes: [
        { id: 'n1', label: '光照', x: 100, y: 170 },
        { id: 'n2', label: '生长', x: 900, y: 170 },
      ],
      edges: [{ from: 'n1', to: 'n2', label: '促进' }],
    };
    const markup = renderToStaticMarkup(
      createElement(CollabBoardContent, { content, label: '课堂简图' }),
    );

    expect(markup).toContain('aria-label="课堂简图"');
    expect(markup).toContain('data-collab-board-node="n1"');
    expect(markup).toContain('data-collab-board-node="n2"');
    expect(markup).toContain('x1="128" y1="170" x2="872" y2="170"');
    expect(markup).toContain('data-from-node="n1" data-to-node="n2"');
    const markerId = markup.match(/<marker id="([^"]+)"/)?.[1];
    expect(markerId).toMatch(/^collab-board-arrow-/);
    expect(markup).toContain(`marker-end="url(#${markerId})"`);
    expect(markup).toContain('data-collab-board-edge-label="true">促进</text>');
    expect(markup).toContain('光照 → 生长：促进');
  });

  it('未知端点只显示不可连接提示，不画虚构的线', () => {
    const content: CollabBoardContentDto['content'] = {
      kind: 'diagram',
      nodes: [{ id: 'known', label: '已知节点', x: 100, y: 100 }],
      edges: [{ from: 'known', to: 'missing', label: '关系' }],
    };
    const markup = renderToStaticMarkup(createElement(CollabBoardContent, { content }));

    expect(markup).not.toContain('<line');
    expect(markup).toContain('data-collab-board-dangling-edge');
    expect(markup).toContain('未知节点 missing');
  });

  it.each([
    { distance: 20, expectedFrom: 104, expectedTo: 116, radius: 4 },
    { distance: 60, expectedFrom: 112, expectedTo: 148, radius: 12 },
  ])(
    '短边距离 $distance 时缩小节点并保留正向可见连接',
    ({ distance, expectedFrom, expectedTo, radius }) => {
      const content: CollabBoardContentDto['content'] = {
        kind: 'diagram',
        nodes: [
          { id: 'a', label: 'A', x: 100, y: 100 },
          { id: 'b', label: 'B', x: 100 + distance, y: 100 },
        ],
        edges: [{ from: 'a', to: 'b', label: '方向' }],
      };
      const markup = renderToStaticMarkup(createElement(CollabBoardContent, { content }));
      const line = markup.match(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/);

      expect(line).not.toBeNull();
      expect(Number(line?.[1])).toBe(expectedFrom);
      expect(Number(line?.[3])).toBe(expectedTo);
      expect(Number(line?.[3])).toBeGreaterThan(Number(line?.[1]));
      expect(markup.match(/<circle/g)).toHaveLength(2);
      expect(markup).toContain(`r="${radius}"`);
      expect(markup).toContain('A → B：方向');
      expect(markup).toContain('marker-end=');
    },
  );

  it('坐标重合的不同节点只给出有向关系文字，不绘制反向或伪造连线', () => {
    const content: CollabBoardContentDto['content'] = {
      kind: 'diagram',
      nodes: [
        { id: 'a', label: '甲', x: 100, y: 100 },
        { id: 'b', label: '乙', x: 100, y: 100 },
      ],
      edges: [{ from: 'a', to: 'b', label: '关联' }],
    };
    const markup = renderToStaticMarkup(createElement(CollabBoardContent, { content }));

    expect(markup).not.toContain('<line');
    expect(markup).not.toContain('data-collab-board-self-loop');
    expect(markup).toContain('data-collab-board-overlap="true"');
    expect(markup).toContain('节点坐标重合，未绘制连线：甲 → 乙：关联');
    expect(markup).not.toContain('乙 → 甲');
  });

  it('自环使用有向曲线，且同页多个简图的箭头 marker ID 唯一', () => {
    const selfLoop: CollabBoardContentDto['content'] = {
      kind: 'diagram',
      nodes: [{ id: 'a', label: '自环节点', x: 100, y: 100 }],
      edges: [{ from: 'a', to: 'a', label: '循环' }],
    };
    const one = createElement(CollabBoardContent, { content: selfLoop });
    const two = createElement(CollabBoardContent, { content: selfLoop });
    const markup = renderToStaticMarkup(createElement('div', null, one, two));
    const markerIds = Array.from(markup.matchAll(/<marker id="([^"]+)"/g), (match) => match[1]);

    expect(markup).toContain('data-collab-board-self-loop="true"');
    expect(markup).toContain('<path d="M');
    expect(markup).toContain('marker-end=');
    expect(markerIds).toHaveLength(2);
    expect(new Set(markerIds).size).toBe(2);
  });

  it('公式显示可读文本和源码，普通文字保留换行', () => {
    const formula = renderToStaticMarkup(
      createElement(CollabBoardContent, {
        content: { kind: 'formula', text: '二次函数', latex: 'y=x^2' },
      }),
    );
    const text = renderToStaticMarkup(
      createElement(CollabBoardContent, { content: { kind: 'text', text: '第一行\n第二行' } }),
    );

    expect(formula).toContain('二次函数');
    expect(formula).toContain('y=x^2');
    expect(text).toContain('第一行\n第二行');
    expect(text).toContain('white-space:pre-wrap');
  });
});
