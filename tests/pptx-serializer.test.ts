import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildPptxDeck } from '@sew/study-domain';
import { readZip } from '@sew/study-storage';
import type { PlanSceneDto } from '@sew/study-contracts';
import { serializeEditablePptx } from '../apps/learning/lib/server/pptx-serializer';

const scene: PlanSceneDto = {
  sceneId: 'scene_native',
  kind: 'slide',
  title: '原生对象',
  statementId: 'statement',
  questionId: null,
  knowledgeIds: [],
  note: '审核后备注',
  elements: [
    {
      elementId: 'el_formula',
      kind: 'text',
      text: '$F=ma$',
      assetRef: null,
      left: 50,
      top: 100,
      width: 400,
      height: 80,
      style: { fontSize: 24, color: '#232323', bold: false, italic: false, align: 'left' },
    },
  ],
};
const identity = {
  projectId: 'project',
  lessonId: 'lesson',
  lessonVersion: 1,
  bundleId: 'bundle',
  title: '文件验收',
  stageId: 'stage',
  dslVersion: '0.11.2',
  documentDigest: 'a'.repeat(64),
  exportedDocumentDigest: 'b'.repeat(64),
  planDigest: null,
};
const deck = () =>
  buildPptxDeck({
    identity,
    scenes: [scene],
    options: {
      documentSceneContent: new Map([
        [
          scene.sceneId,
          {
            canvas: {
              elements: [
                {
                  id: 'table',
                  type: 'table',
                  left: 50,
                  top: 220,
                  width: 400,
                  height: 140,
                  rows: [
                    ['变量', '值'],
                    ['质量', '2'],
                  ],
                },
                {
                  id: 'chart',
                  type: 'chart',
                  left: 530,
                  top: 150,
                  width: 400,
                  height: 240,
                  chartType: 'bar',
                  categories: ['一', '二'],
                  series: [{ name: '观察', values: [2, 4] }],
                },
              ],
            },
          },
        ],
      ]),
    },
  });

describe('actual editable PowerPoint serialization', () => {
  it('writes native table/chart objects with editable workbook data and formula source text', async () => {
    const bytes = await serializeEditablePptx(deck());
    const parts = readZip(bytes, { allowEmptyDirectories: true });
    const core = Buffer.from(
      parts.find((part) => part.path === 'docProps/core.xml')!.bytes,
    ).toString('utf8');
    expect(core).toContain('SEW-PPTX-1');
    expect(core).toContain(identity.documentDigest);
    expect(core).toContain(identity.exportedDocumentDigest);
    const xml = Buffer.from(
      parts.find((part) => part.path === 'ppt/slides/slide1.xml')!.bytes,
    ).toString('utf8');
    expect(xml).toContain('<a:tbl>');
    expect(xml).toContain('<c:chart');
    expect(xml).toContain('F=ma');
    expect(parts.some((part) => /^ppt\/charts\/chart\d+\.xml$/.test(part.path))).toBe(true);
    const workbook = parts.find((part) => /^ppt\/embeddings\/.*\.xlsx$/.test(part.path))!;
    expect(
      readZip(workbook.bytes, { allowEmptyDirectories: true }).some((part) =>
        part.path.startsWith('xl/worksheets/'),
      ),
    ).toBe(true);
    expect(
      parts.some(
        (part) =>
          part.path.endsWith('.rels') &&
          Buffer.from(part.bytes).toString().includes('TargetMode="External"'),
      ),
    ).toBe(false);
  });

  it('rejects mutated deck content before serialization', async () => {
    const value = deck();
    await expect(
      serializeEditablePptx({ ...value, identity: { ...identity, title: 'changed' } }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('requires independently supplied matching image bytes and never downloads a reference', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
      'base64',
    );
    const value = buildPptxDeck({
      identity,
      scenes: [
        {
          ...scene,
          elements: [
            ...scene.elements,
            {
              ...scene.elements[0]!,
              elementId: 'el_image',
              kind: 'image',
              text: '',
              assetRef: 'image',
            },
          ],
        },
      ],
      options: {
        media: new Map([
          [
            'image',
            {
              reference: 'assets/image.png',
              mediaType: 'image/png',
              sha256: createHash('sha256').update(bytes).digest('hex'),
              byteLength: bytes.byteLength,
            },
          ],
        ]),
      },
    });
    await expect(serializeEditablePptx(value)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      serializeEditablePptx(
        value,
        new Map([['assets/image.png', { bytes: Uint8Array.from([1, 2, 3]), mime: 'image/png' }]]),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      (
        await serializeEditablePptx(
          value,
          new Map([['assets/image.png', { bytes, mime: 'image/png' }]]),
        )
      ).byteLength,
    ).toBeGreaterThan(1000);
  });
});
