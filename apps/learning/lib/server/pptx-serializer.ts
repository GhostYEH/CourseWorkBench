import PptxGenJS from 'pptxgenjs';
import { createHash } from 'node:crypto';
import { StudyError } from '@sew/study-contracts';
import {
  assertPptxDeckEditable,
  assertPptxDeckSchemaClosed,
  pptxDeckDigest,
  type PptxDeck,
  type PptxFrame,
} from '@sew/study-domain';
import { readZip } from '@sew/study-storage';
import { injectNativeMath } from './pptx-math';
import { embedProvisionedPptxFont, type PptxFontProvision } from './pptx-fonts';

export interface PptxBinaryAsset {
  bytes: Uint8Array;
  mime: string;
}
const emu = (value: number): number => value / 914400;
const frame = (value: PptxFrame) => ({
  x: emu(value.leftEmu),
  y: emu(value.topEmu),
  w: emu(value.widthEmu),
  h: emu(value.heightEmu),
});
const color = (value: string): string => value.replace(/^#/, '');

/** Native text, tables, charts and lines remain individually editable; no screenshot slide substitute. */
export async function serializeEditablePptx(
  deck: PptxDeck,
  assets: ReadonlyMap<string, PptxBinaryAsset> = new Map(),
  font: PptxFontProvision | null = null,
): Promise<Uint8Array> {
  assertPptxDeckSchemaClosed(deck);
  assertPptxDeckEditable(deck);
  if (deck.digest !== pptxDeckDigest(deck))
    throw new StudyError('VERSION_CONFLICT', { reason: 'pptx_deck_changed' });
  if (deck.slides.length > 48)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'pptx_slide_limit' });
  const presentation = new PptxGenJS();
  presentation.defineLayout({
    name: 'FROZEN_LESSON',
    width: emu(deck.slideSize.widthEmu),
    height: emu(deck.slideSize.heightEmu),
  });
  presentation.layout = 'FROZEN_LESSON';
  presentation.author = '学科备考工作台';
  // Source identity travels with the PPTX itself, including after a browser-only download.
  presentation.subject = `SEW-PPTX-1 ${JSON.stringify(deck.identity)}`;
  presentation.title = deck.identity.title;
  presentation.theme = { headFontFace: deck.theme.fontName, bodyFontFace: deck.theme.fontName };
  let totalAssetBytes = 0;
  for (const item of deck.slides) {
    const slide = presentation.addSlide();
    slide.background = { color: color(deck.theme.backgroundColor) };
    slide.addNotes(item.notes);
    for (const shape of item.shapes) {
      if (shape.kind === 'text') {
        slide.addText(
          shape.runs.map((run) => ({
            text: run.text,
            options: {
              bold: run.bold,
              italic: run.italic,
              ...(run.underline ? { underline: { style: 'sng' as const } } : {}),
              subscript: run.baseline === 'sub',
              superscript: run.baseline === 'sup',
              fontSize: run.sizeCentipoints / 100,
              fontFace: run.fontName,
              color: color(run.color),
            },
          })),
          {
            ...frame(shape.frame),
            align: shape.alignment,
            margin: 0,
            breakLine: false,
            valign: 'top',
            fit: 'shrink',
            objectName: shape.shapeId,
          },
        );
      } else if (shape.kind === 'formula') {
        // Preserve the source as editable text; native OMML conversion is a separate supported-format boundary.
        slide.addText(shape.latex ?? shape.plainText, {
          ...frame(shape.frame),
          fontFace: deck.theme.fontName,
          fontSize: shape.sizeCentipoints / 100,
          margin: 0,
          objectName: shape.shapeId,
        });
      } else if (shape.kind === 'table') {
        slide.addTable(
          shape.rows.map((row) => row.map((text) => ({ text }))),
          {
            ...frame(shape.frame),
            fontFace: deck.theme.fontName,
            fontSize: 14,
            margin: 0.03,
            border: { type: 'solid', pt: 0.5, color: '808080' },
            autoPage: false,
            objectName: shape.shapeId,
          },
        );
      } else if (shape.kind === 'chart') {
        slide.addChart(
          presentation.ChartType[shape.chartType],
          shape.series.map((series) => ({
            name: series.name,
            labels: [...shape.categories],
            values: [...series.values],
          })),
          {
            ...frame(shape.frame),
            showLegend: shape.series.length > 1,
            showTitle: false,
            objectName: shape.shapeId,
          },
        );
      } else if (shape.kind === 'line') {
        const x1 = emu(shape.startEmu.xEmu),
          y1 = emu(shape.startEmu.yEmu),
          x2 = emu(shape.endEmu.xEmu),
          y2 = emu(shape.endEmu.yEmu);
        slide.addShape(presentation.ShapeType.line, {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
          flipH: x2 < x1,
          flipV: y2 < y1,
          line: { color: color(deck.theme.fontColor), width: shape.widthEmu / 12700 },
          objectName: shape.shapeId,
        });
      } else {
        const asset = assets.get(shape.reference);
        if (
          !asset ||
          !['image/png', 'image/jpeg', 'image/gif'].includes(asset.mime) ||
          asset.bytes.byteLength === 0 ||
          asset.bytes.byteLength > 16 * 1024 * 1024
        )
          throw new StudyError('INVALID_ARGUMENT', {
            reason: 'pptx_binary_asset_missing_or_unsupported',
          });
        if (shape.sha256 && createHash('sha256').update(asset.bytes).digest('hex') !== shape.sha256)
          throw new StudyError('VERSION_CONFLICT', { reason: 'pptx_asset_digest_changed' });
        totalAssetBytes += asset.bytes.byteLength;
        if (totalAssetBytes > 64 * 1024 * 1024)
          throw new StudyError('INVALID_ARGUMENT', { reason: 'pptx_total_assets_limit' });
        slide.addImage({
          ...frame(shape.frame),
          data: `${asset.mime};base64,${Buffer.from(asset.bytes).toString('base64')}`,
          objectName: shape.shapeId,
        });
      }
    }
  }
  const generated = await presentation.write({ outputType: 'uint8array', compression: true });
  const output = generated instanceof Uint8Array ? injectNativeMath(generated, deck) : generated;
  if (!(output instanceof Uint8Array) || output.byteLength > 96 * 1024 * 1024)
    throw new StudyError('INTERNAL', { reason: 'pptx_serialization_invalid' });
  const withFont = embedProvisionedPptxFont(output, deck, font);
  if (withFont.bytes.byteLength > 96 * 1024 * 1024)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'pptx_total_assets_limit' });
  const parts = readZip(withFont.bytes, { allowEmptyDirectories: true });
  const slides = parts.filter((part) => /^ppt\/slides\/slide\d+\.xml$/.test(part.path));
  if (
    slides.length !== deck.slides.length ||
    !parts.some((part) => part.path === '[Content_Types].xml') ||
    !parts.some((part) => part.path === 'ppt/presentation.xml') ||
    parts.some(
      (part) =>
        part.path.endsWith('.rels') &&
        Buffer.from(part.bytes).toString('utf8').includes('TargetMode="External"'),
    )
  )
    throw new StudyError('INTERNAL', { reason: 'pptx_readback_failed' });
  return withFont.bytes;
}
