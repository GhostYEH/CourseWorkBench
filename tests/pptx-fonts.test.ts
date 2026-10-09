import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPptxDeck } from '@sew/study-domain';
import { readZip } from '@sew/study-storage';
import {
  assessPptxFontProvision,
  embedProvisionedPptxFont,
  loadBundledPptxFont,
} from '../apps/learning/lib/server/pptx-fonts';
import type { PptxFontProvision } from '../apps/learning/lib/server/pptx-fonts';
import { inspectPptxMathXml } from '../apps/learning/lib/server/pptx-math';
import { serializeEditablePptx } from '../apps/learning/lib/server/pptx-serializer';

const identity = {
  projectId: 'project',
  lessonId: 'lesson',
  lessonVersion: 1,
  bundleId: 'bundle',
  title: 'Font',
  stageId: 'stage',
  dslVersion: '0.11.2',
  documentDigest: 'a'.repeat(64),
  exportedDocumentDigest: 'b'.repeat(64),
  planDigest: null,
};
const deckWithFont = (typeface: string) =>
  buildPptxDeck({
    identity,
    scenes: [
      {
        sceneId: 'scene_font',
        kind: 'slide',
        title: '字体',
        statementId: null,
        questionId: null,
        knowledgeIds: [],
        note: '',
        elements: [
          {
            elementId: 'text',
            kind: 'text',
            text: '可编辑字体测试',
            assetRef: null,
            left: 30,
            top: 30,
            width: 400,
            height: 100,
            style: { fontSize: 24, color: '#222222', bold: false, italic: false, align: 'left' },
          },
        ],
      },
    ],
    options: { theme: { fontName: typeface } },
  });
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const withFsType = (font: PptxFontProvision, fsType: number): PptxFontProvision => {
  const bytes = Uint8Array.from(font.bytes);
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = view.readUInt16BE(4);
  let os2Offset = -1;
  for (let index = 0; index < tableCount; index += 1) {
    const offset = 12 + index * 16;
    if (view.toString('ascii', offset, offset + 4) === 'OS/2')
      os2Offset = view.readUInt32BE(offset + 8);
  }
  if (os2Offset < 0) throw new Error('OS/2 table missing');
  view.writeUInt16BE(fsType, os2Offset + 8);
  return { ...font, bytes, sha256: sha(bytes) };
};

describe('licensed PowerPoint font embedding', () => {
  it('loads the pinned static OFL face and embeds its bytes into PresentationML', async () => {
    const font = loadBundledPptxFont();
    expect(font).not.toBeNull();
    expect(font && assessPptxFontProvision(font, 'Noto Sans CJK SC').embeddable).toBe(true);
    const deck = deckWithFont('Noto Sans CJK SC');
    const initial = await serializeEditablePptx(deck);
    const result = embedProvisionedPptxFont(initial, deck, font);
    expect(result.embedded).toBe(true);
    expect(result.bytes.byteLength).toBeGreaterThan(initial.byteLength + 16_000_000);
    const parts = readZip(result.bytes, { allowEmptyDirectories: true });
    const fontPart = parts.find((part) => part.path === 'ppt/fonts/font1.fntdata')!;
    expect(sha(fontPart.bytes)).toBe(font!.sha256);
    expect(
      parts.find((part) => part.path.endsWith(`OFL-${font!.licenseReceiptSha256.slice(0, 12)}.txt`))
        ?.bytes,
    ).toEqual(font!.licenseReceipt);
    expect(
      parts.find((part) =>
        part.path.endsWith(`NOTICE-${font!.copyrightNoticeSha256.slice(0, 12)}.txt`),
      )?.bytes,
    ).toEqual(font!.copyrightNotice);
    const presentation = Buffer.from(
      parts.find((part) => part.path === 'ppt/presentation.xml')!.bytes,
    ).toString();
    expect(presentation).toContain('embedTrueTypeFonts="1"');
    expect(presentation).toContain('saveSubsetFonts="0"');
    expect(presentation).toContain('<p:embeddedFontLst>');
    expect(presentation).toContain('<p:regular r:id=');
    expect(presentation).not.toContain('<p:bold ');
    const rels = Buffer.from(
      parts.find((part) => part.path === 'ppt/_rels/presentation.xml.rels')!.bytes,
    ).toString();
    expect(rels).toContain('relationships/font');
    expect(rels).toContain('Target="fonts/font1.fntdata"');
    expect(
      Buffer.from(parts.find((part) => part.path === '[Content_Types].xml')!.bytes).toString(),
    ).toContain('ContentType="application/x-fontdata"');
    expect(inspectPptxMathXml(presentation)).toMatchObject({
      alternateContent: 0,
      mathExtensions: 0,
      mathObjects: 0,
    });
    expect(
      parts.some(
        (part) =>
          part.path.endsWith('.rels') &&
          Buffer.from(part.bytes).toString().includes('TargetMode="External"'),
      ),
    ).toBe(false);
  });

  it('honors OpenType fsType and selected family instead of embedding restricted or unrelated fonts', () => {
    const font = loadBundledPptxFont()!;
    expect(assessPptxFontProvision(withFsType(font, 0x0002), font.typeface)).toMatchObject({
      embeddable: false,
      reason: 'font_license_restricts_editing',
    });
    expect(assessPptxFontProvision(withFsType(font, 0x0004), font.typeface)).toMatchObject({
      embeddable: false,
      reason: 'font_license_restricts_editing',
    });
    expect(assessPptxFontProvision(withFsType(font, 0x0008), font.typeface)).toMatchObject({
      embeddable: true,
    });
    expect(assessPptxFontProvision(withFsType(font, 0x0100), font.typeface)).toMatchObject({
      embeddable: true,
    });
    expect(assessPptxFontProvision(withFsType(font, 0x0010), font.typeface)).toMatchObject({
      embeddable: false,
      reason: 'font_license_restricts_editing',
    });
    expect(assessPptxFontProvision(font, 'Microsoft YaHei')).toMatchObject({
      embeddable: false,
      reason: 'font_family_mismatch',
    });
  });

  it('includes the complete license receipt alongside the bundled font', () => {
    const receiptPath = 'apps/learning/resources/fonts/noto-sans-cjk-sc/FONT-RECEIPT.json';
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      fontSha256: string;
      licenseSha256: string;
      noticeSha256: string;
    };
    const font = loadBundledPptxFont()!;
    const license = Uint8Array.from(
      readFileSync('apps/learning/resources/fonts/noto-sans-cjk-sc/OFL.txt'),
    );
    expect(receipt.fontSha256).toBe(font.sha256);
    expect(sha(license)).toBe('6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2');
    expect(sha(font!.copyrightNotice)).toBe(receipt.noticeSha256);
  });
});
