import { describe, expect, it } from 'vitest';
import { buildPptxDeck } from '@sew/study-domain';
import { readZip } from '@sew/study-storage';
import type { PlanSceneDto } from '@sew/study-contracts';
import { convertLatexToOmml, inspectPptxMathXml } from '../apps/learning/lib/server/pptx-math';
import { serializeEditablePptx } from '../apps/learning/lib/server/pptx-serializer';

const identity = {
  projectId: 'project',
  lessonId: 'lesson',
  lessonVersion: 1,
  bundleId: 'bundle',
  title: 'Office Math',
  stageId: 'stage',
  dslVersion: '0.11.2',
  documentDigest: 'a'.repeat(64),
  exportedDocumentDigest: 'b'.repeat(64),
  planDigest: null,
};

const deckFor = (latex: string) => {
  const scene: PlanSceneDto = {
    sceneId: 'scene_math',
    kind: 'slide',
    title: '公式',
    statementId: null,
    questionId: null,
    knowledgeIds: [],
    note: '',
    elements: [
      {
        elementId: 'formula',
        kind: 'text',
        text: `$${latex}$`,
        assetRef: null,
        left: 30,
        top: 30,
        width: 400,
        height: 100,
        style: { fontSize: 28, color: '#222222', bold: false, italic: false, align: 'left' },
      },
    ],
  };
  return buildPptxDeck({ identity, scenes: [scene] });
};

describe('PowerPoint native Office Math conversion', () => {
  it('maps supported fractions, roots and scripts to editable OMML structures', () => {
    expect(convertLatexToOmml(String.raw`\frac{x_1^2+1}{\sqrt[3]{y}}`)).toMatchObject({
      supported: true,
    });
    const converted = convertLatexToOmml(String.raw`\frac{x_1^2+1}{\sqrt[3]{y}}`);
    expect(converted.supported && converted.omml).toContain('<m:f>');
    expect(converted.supported && converted.omml).toContain('<m:sSubSup>');
    expect(converted.supported && converted.omml).toContain('<m:rad>');
  });

  it('reports unsupported MathML rather than treating an unsupported expression as converted math', () => {
    expect(convertLatexToOmml(String.raw`\begin{matrix}a&b\\c&d\end{matrix}`)).toEqual({
      supported: false,
      reason: 'unsupported-mathml-node',
    });
  });
  it('preserves invisible phantom source instead of making its child visible', async () => {
    const latex = String.raw`a+\phantom{x}+b`;
    expect(convertLatexToOmml(latex)).toEqual({
      supported: false,
      reason: 'unsupported-mathml-node',
    });
    const bytes = await serializeEditablePptx(deckFor(latex));
    const slide = Buffer.from(
      readZip(bytes, { allowEmptyDirectories: true }).find(
        (part) => part.path === 'ppt/slides/slide1.xml',
      )!.bytes,
    ).toString();
    expect(inspectPptxMathXml(slide).mathObjects).toBe(0);
    expect(slide).toContain(latex);
  });

  it('writes a genuine PresentationML Office Math object and keeps an editable fallback', async () => {
    const bytes = await serializeEditablePptx(deckFor(String.raw`\frac{x_1^2+1}{\sqrt{3}}`));
    const parts = readZip(bytes, { allowEmptyDirectories: true });
    const slide = Buffer.from(
      parts.find((part) => part.path === 'ppt/slides/slide1.xml')!.bytes,
    ).toString();
    // Independent package readback checks the PowerPoint DrawingML extension, not converter output.
    expect(inspectPptxMathXml(slide)).toEqual({
      alternateContent: 1,
      mathExtensions: 1,
      mathObjects: 1,
    });
    expect(slide).toContain('<mc:AlternateContent');
    expect(slide).toContain('<mc:Choice Requires="a14">');
    expect(slide).toContain('<a14:m>');
    expect(slide).toContain('<m:oMathPara>');
    expect(slide).toContain('<m:f>');
    expect(slide).toContain('<m:sSubSup>');
    expect(slide).toContain('<mc:Fallback>');
    expect(slide).toContain('frac');
    expect(parts.some((part) => part.path.startsWith('ppt/media/'))).toBe(false);
    expect(
      parts.some(
        (part) =>
          part.path.endsWith('.rels') &&
          Buffer.from(part.bytes).toString().includes('TargetMode="External"'),
      ),
    ).toBe(false);
  });

  it('converts supported inline math while retaining the original text shape as a fallback', async () => {
    const deck = buildPptxDeck({
      identity,
      scenes: [
        {
          sceneId: 'scene_inline',
          kind: 'slide',
          title: '行内公式',
          statementId: null,
          questionId: null,
          knowledgeIds: [],
          note: '',
          elements: [
            {
              elementId: 'inline',
              kind: 'text',
              text: '速度为 $v=\\frac{s}{t}$。',
              assetRef: null,
              left: 30,
              top: 30,
              width: 500,
              height: 80,
              style: { fontSize: 20, color: '#222222', bold: false, italic: false, align: 'left' },
            },
          ],
        },
      ],
    });
    const bytes = await serializeEditablePptx(deck);
    const slide = Buffer.from(
      readZip(bytes, { allowEmptyDirectories: true }).find(
        (part) => part.path === 'ppt/slides/slide1.xml',
      )!.bytes,
    ).toString();
    expect(slide).toContain('<a14:m><m:oMath>');
    expect(slide).toContain('<mc:Fallback>');
    expect(slide).toContain('v=\\frac{s}{t}');
  });

  it('keeps unsupported expressions as literal editable source with no false native-math marker', async () => {
    const bytes = await serializeEditablePptx(
      deckFor(String.raw`\begin{matrix}a&b\\c&d\end{matrix}`),
    );
    const slide = Buffer.from(
      readZip(bytes, { allowEmptyDirectories: true }).find(
        (part) => part.path === 'ppt/slides/slide1.xml',
      )!.bytes,
    ).toString();
    expect(slide).not.toContain('<a14:m>');
    expect(slide).toContain(String.raw`\begin{matrix}`);
  });
});
