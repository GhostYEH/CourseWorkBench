import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { readZip, writeZip } from '@sew/study-storage';
import type { PptxDeck } from '@sew/study-domain';

const FONT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const BUNDLED_FONT_PATH = 'resources/fonts/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf';
const BUNDLED_FONT_SHA256 = '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b';
const BUNDLED_LICENSE_SHA256 = '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2';
const BUNDLED_NOTICE_SHA256 = '75b2ec9365b7dda3f77e98a58960855808269ef032db1037955e58b704baad2e';
const BUNDLED_FONT_BYTES = 16_437_364;

export interface PptxFontProvision {
  readonly typeface: string;
  readonly face: 'regular' | 'bold' | 'italic' | 'boldItalic';
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly licenseId: string;
  readonly licenseReceiptSha256: string;
  readonly licenseReceipt: Uint8Array;
  readonly copyrightNotice: Uint8Array;
  readonly copyrightNoticeSha256: string;
  readonly sourceCommit: string;
  readonly pitchFamily?: number;
  readonly charset?: number;
}

export interface PptxFontEmbeddingResult {
  readonly bytes: Uint8Array;
  readonly embedded: boolean;
  readonly reason:
    'embedded' | 'font_missing' | 'font_family_mismatch' | 'font_license_restricts_editing';
  readonly typeface: string | null;
  readonly fontSha256: string | null;
}
export interface PptxFontAssessment {
  readonly embeddable: boolean;
  readonly reason:
    'embedded' | 'font_missing' | 'font_family_mismatch' | 'font_license_restricts_editing';
}

interface SfntFacts {
  family: string;
  face: string;
  fsType: number;
  variable: boolean;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const readU16 = (bytes: Uint8Array, offset: number): number =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt16BE(offset);
const readU32 = (bytes: Uint8Array, offset: number): number =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32BE(offset);

const inspectSfnt = (bytes: Uint8Array): SfntFacts => {
  if (bytes.byteLength < 1024 || bytes.byteLength > 32 * 1024 * 1024)
    throw new Error('pptx_font_size_invalid');
  const sfnt = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = sfnt.toString('ascii', 0, 4);
  if (signature !== 'OTTO' && readU32(bytes, 0) !== 0x00010000)
    throw new Error('pptx_font_format_unsupported');
  const tableCount = readU16(bytes, 4);
  if (tableCount < 1 || tableCount > 512 || 12 + tableCount * 16 > bytes.byteLength)
    throw new Error('pptx_font_table_directory_invalid');
  const tables = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < tableCount; index += 1) {
    const offset = 12 + index * 16;
    const tag = sfnt.toString('ascii', offset, offset + 4);
    const tableOffset = readU32(bytes, offset + 8);
    const length = readU32(bytes, offset + 12);
    if (tableOffset + length > bytes.byteLength) throw new Error('pptx_font_table_out_of_bounds');
    tables.set(tag, { offset: tableOffset, length });
  }
  const os2 = tables.get('OS/2');
  const name = tables.get('name');
  if (!os2 || os2.length < 10 || !name || name.length < 6)
    throw new Error('pptx_font_metadata_missing');
  const fsType = readU16(bytes, os2.offset + 8);
  const nameFormat = readU16(bytes, name.offset);
  const nameCount = readU16(bytes, name.offset + 2);
  const stringOffset = readU16(bytes, name.offset + 4);
  if (nameFormat > 1 || nameCount > 20_000 || 6 + nameCount * 12 > name.length)
    throw new Error('pptx_font_name_table_invalid');
  const names = new Map<number, string[]>();
  for (let index = 0; index < nameCount; index += 1) {
    const entry = name.offset + 6 + index * 12;
    const platform = readU16(bytes, entry);
    const nameId = readU16(bytes, entry + 6);
    const length = readU16(bytes, entry + 8);
    const textOffset = readU16(bytes, entry + 10);
    if (![0, 3].includes(platform) || ![1, 2, 4, 6, 16, 17].includes(nameId)) continue;
    const start = name.offset + stringOffset + textOffset;
    if (start + length > name.offset + name.length || length % 2 !== 0) continue;
    let text = '';
    for (let byte = start; byte < start + length; byte += 2)
      text += String.fromCharCode((bytes[byte]! << 8) | bytes[byte + 1]!);
    const values = names.get(nameId) ?? [];
    values.push(text.replace(/\0/g, '').trim());
    names.set(nameId, values);
  }
  const family = (names.get(16)?.find(Boolean) ?? names.get(1)?.find(Boolean) ?? '').trim();
  const face = (names.get(17)?.find(Boolean) ?? names.get(2)?.find(Boolean) ?? '').trim();
  if (!family || !face) throw new Error('pptx_font_family_name_missing');
  return { family, face, fsType, variable: tables.has('fvar') };
};

/** The checked-in font is loaded only from the app's fixed resource locations; callers cannot pass paths. */
export const loadBundledPptxFont = (): PptxFontProvision | null => {
  const candidates = [
    resolve(process.cwd(), BUNDLED_FONT_PATH),
    resolve(process.cwd(), 'apps/learning', BUNDLED_FONT_PATH),
  ];
  const fontPath = candidates.find(existsSync);
  if (!fontPath) return null;
  const bytes = Uint8Array.from(readFileSync(fontPath));
  const licensePath = resolve(fontPath, '..', 'OFL.txt');
  const noticePath = resolve(fontPath, '..', 'NOTICE.txt');
  if (!existsSync(licensePath) || !existsSync(noticePath))
    throw new Error('pptx_bundled_font_license_missing');
  const licenseReceipt = Uint8Array.from(readFileSync(licensePath));
  const copyrightNotice = Uint8Array.from(readFileSync(noticePath));
  const hash = sha256(bytes);
  if (
    bytes.byteLength !== BUNDLED_FONT_BYTES ||
    hash !== BUNDLED_FONT_SHA256 ||
    sha256(licenseReceipt) !== BUNDLED_LICENSE_SHA256 ||
    sha256(copyrightNotice) !== BUNDLED_NOTICE_SHA256
  )
    throw new Error('pptx_bundled_font_digest_mismatch');
  return {
    typeface: 'Noto Sans CJK SC',
    face: 'regular',
    bytes,
    sha256: hash,
    licenseId: 'OFL-1.1',
    licenseReceiptSha256: BUNDLED_LICENSE_SHA256,
    licenseReceipt,
    copyrightNotice,
    copyrightNoticeSha256: BUNDLED_NOTICE_SHA256,
    sourceCommit: '523d033d6cb47f4a80c58a35753646f5c3608a78',
    pitchFamily: 34,
    charset: 0,
  };
};

const parseXml = (xml: string): Document => {
  const errors: string[] = [];
  const parsed = new DOMParser({
    errorHandler: (level, message) => errors.push(`${level}:${message}`),
  }).parseFromString(xml, 'application/xml');
  if (errors.length || parsed.getElementsByTagName('parsererror').length)
    throw new Error('pptx_font_package_xml_invalid');
  return parsed;
};
const serializeXml = (document: Document): Uint8Array =>
  Buffer.from(new XMLSerializer().serializeToString(document), 'utf8');

const getFontRights = (facts: SfntFacts): 'allowed' | 'blocked' => {
  const usage = facts.fsType & 0x000f;
  // Preview/print-only fonts would make this editable deck read-only; bitmap-only fonts cannot be embedded as text.
  if ((facts.fsType & 0x0200) !== 0 || usage === 0x0002 || usage === 0x0004) return 'blocked';
  // The only non-usage flag supported here is no-subsetting; we always store the complete face.
  if ((facts.fsType & 0xfff0 & ~0x0100) !== 0) return 'blocked';
  if (usage !== 0x0000 && usage !== 0x0008) return 'blocked';
  return 'allowed';
};

const pushFontXml = (
  parts: { path: string; bytes: Uint8Array }[],
  font: PptxFontProvision,
): void => {
  const presentationPart = parts.find((part) => part.path === 'ppt/presentation.xml');
  const relsPart = parts.find((part) => part.path === 'ppt/_rels/presentation.xml.rels');
  const contentTypesPart = parts.find((part) => part.path === '[Content_Types].xml');
  if (!presentationPart || !relsPart || !contentTypesPart)
    throw new Error('pptx_font_package_parts_missing');
  const presentation = parseXml(Buffer.from(presentationPart.bytes).toString('utf8'));
  const rels = parseXml(Buffer.from(relsPart.bytes).toString('utf8'));
  const contentTypes = parseXml(Buffer.from(contentTypesPart.bytes).toString('utf8'));
  const root = presentation.documentElement;
  if (root.namespaceURI !== P_NS) throw new Error('pptx_presentation_namespace_invalid');
  if (
    Array.from(presentation.getElementsByTagNameNS(P_NS, 'font')).some(
      (element) => element.getAttribute('typeface') === font.typeface,
    )
  )
    throw new Error('pptx_font_family_already_embedded');
  const ids = Array.from(rels.getElementsByTagNameNS(REL_NS, 'Relationship'))
    .map((relation) => Number.parseInt((relation.getAttribute('Id') ?? '').replace(/^rId/, ''), 10))
    .filter(Number.isFinite);
  const relationshipId = `rId${Math.max(0, ...ids) + 1}`;
  const fontPath = 'ppt/fonts/font1.fntdata';
  if (parts.some((part) => part.path === fontPath)) throw new Error('pptx_font_part_collision');

  const relationships = rels.createElementNS(REL_NS, 'Relationship');
  relationships.setAttribute('Id', relationshipId);
  relationships.setAttribute('Type', FONT_REL);
  relationships.setAttribute('Target', 'fonts/font1.fntdata');
  rels.documentElement.appendChild(relationships);

  if (
    !Array.from(contentTypes.getElementsByTagNameNS(CT_NS, 'Default')).some(
      (entry) => entry.getAttribute('Extension') === 'fntdata',
    )
  ) {
    const type = contentTypes.createElementNS(CT_NS, 'Default');
    type.setAttribute('Extension', 'fntdata');
    type.setAttribute('ContentType', 'application/x-fontdata');
    contentTypes.documentElement.appendChild(type);
  }
  if (
    !Array.from(contentTypes.getElementsByTagNameNS(CT_NS, 'Default')).some(
      (entry) => entry.getAttribute('Extension') === 'txt',
    )
  ) {
    const type = contentTypes.createElementNS(CT_NS, 'Default');
    type.setAttribute('Extension', 'txt');
    type.setAttribute('ContentType', 'text/plain');
    contentTypes.documentElement.appendChild(type);
  }

  const embeddedFonts = presentation.createElementNS(P_NS, 'p:embeddedFontLst');
  const embeddedFont = presentation.createElementNS(P_NS, 'p:embeddedFont');
  const face = presentation.createElementNS(P_NS, 'p:font');
  face.setAttribute('typeface', font.typeface);
  face.setAttribute('pitchFamily', String(font.pitchFamily ?? 0));
  face.setAttribute('charset', String(font.charset ?? 0));
  const fontElement = presentation.createElementNS(
    P_NS,
    `p:${font.face === 'boldItalic' ? 'boldItalic' : font.face}`,
  );
  fontElement.setAttributeNS(R_NS, 'r:id', relationshipId);
  embeddedFont.appendChild(face);
  embeddedFont.appendChild(fontElement);
  embeddedFonts.appendChild(embeddedFont);
  const defaultTextStyle = Array.from(root.childNodes).find(
    (child) => child.nodeType === 1 && (child as Element).localName === 'defaultTextStyle',
  );
  root.insertBefore(embeddedFonts, defaultTextStyle ?? null);
  root.setAttribute('embedTrueTypeFonts', '1');
  root.setAttribute('saveSubsetFonts', '0');

  parts.splice(parts.indexOf(presentationPart), 1, {
    path: presentationPart.path,
    bytes: serializeXml(presentation),
  });
  parts.splice(parts.indexOf(relsPart), 1, { path: relsPart.path, bytes: serializeXml(rels) });
  parts.splice(parts.indexOf(contentTypesPart), 1, {
    path: contentTypesPart.path,
    bytes: serializeXml(contentTypes),
  });
  parts.push({ path: fontPath, bytes: font.bytes });
  parts.push({
    path: `ppt/fonts/OFL-${font.licenseReceiptSha256.slice(0, 12)}.txt`,
    bytes: font.licenseReceipt,
  });
  parts.push({
    path: `ppt/fonts/NOTICE-${font.copyrightNoticeSha256.slice(0, 12)}.txt`,
    bytes: font.copyrightNotice,
  });
};

export const embedProvisionedPptxFont = (
  pptx: Uint8Array,
  deck: PptxDeck,
  provision: PptxFontProvision | null,
): PptxFontEmbeddingResult => {
  if (!provision)
    return {
      bytes: pptx,
      embedded: false,
      reason: 'font_missing',
      typeface: null,
      fontSha256: null,
    };
  if (provision.typeface !== deck.theme.fontName)
    return {
      bytes: pptx,
      embedded: false,
      reason: 'font_family_mismatch',
      typeface: provision.typeface,
      fontSha256: provision.sha256,
    };
  const assessment = assessPptxFontProvision(provision, deck.theme.fontName);
  if (!assessment.embeddable)
    return {
      bytes: pptx,
      embedded: false,
      reason: assessment.reason,
      typeface: provision.typeface,
      fontSha256: provision.sha256,
    };
  const parts = readZip(pptx, { allowEmptyDirectories: true }).map((part) => ({
    path: part.path,
    bytes: Uint8Array.from(part.bytes),
  }));
  pushFontXml(parts, provision);
  const bytes = Uint8Array.from(writeZip(parts));
  const readback = readZip(bytes, { allowEmptyDirectories: true });
  const fontPart = readback.find((part) => part.path === 'ppt/fonts/font1.fntdata');
  const presentationPart = readback.find((part) => part.path === 'ppt/presentation.xml');
  const relsPart = readback.find((part) => part.path === 'ppt/_rels/presentation.xml.rels');
  const contentTypesPart = readback.find((part) => part.path === '[Content_Types].xml');
  if (
    !fontPart ||
    sha256(fontPart.bytes) !== provision.sha256 ||
    !presentationPart ||
    !relsPart ||
    !contentTypesPart
  )
    throw new Error('pptx_font_readback_failed');
  const licensePart = readback.find(
    (part) => part.path === `ppt/fonts/OFL-${provision.licenseReceiptSha256.slice(0, 12)}.txt`,
  );
  const noticePart = readback.find(
    (part) => part.path === `ppt/fonts/NOTICE-${provision.copyrightNoticeSha256.slice(0, 12)}.txt`,
  );
  if (
    !licensePart ||
    sha256(licensePart.bytes) !== provision.licenseReceiptSha256 ||
    !noticePart ||
    sha256(noticePart.bytes) !== provision.copyrightNoticeSha256
  )
    throw new Error('pptx_font_license_readback_failed');
  const presentation = parseXml(Buffer.from(presentationPart.bytes).toString('utf8'));
  const rels = parseXml(Buffer.from(relsPart.bytes).toString('utf8'));
  const contentTypes = parseXml(Buffer.from(contentTypesPart.bytes).toString('utf8'));
  const faceNodes = Array.from(presentation.getElementsByTagNameNS(P_NS, 'font'));
  const faceTag = provision.face === 'boldItalic' ? 'boldItalic' : provision.face;
  const relationship = Array.from(rels.getElementsByTagNameNS(REL_NS, 'Relationship')).find(
    (item) =>
      item.getAttribute('Type') === FONT_REL &&
      item.getAttribute('Target') === 'fonts/font1.fntdata',
  );
  const embeddedFace = Array.from(presentation.getElementsByTagNameNS(P_NS, faceTag)).find(
    (item) =>
      item.parentNode?.nodeType === 1 &&
      (item.parentNode as Element).localName === 'embeddedFont' &&
      (item.parentNode as Element).namespaceURI === P_NS,
  );
  const defaultType = Array.from(contentTypes.getElementsByTagNameNS(CT_NS, 'Default')).some(
    (item) =>
      item.getAttribute('Extension') === 'fntdata' &&
      item.getAttribute('ContentType') === 'application/x-fontdata',
  );
  if (
    presentation.documentElement.getAttribute('embedTrueTypeFonts') !== '1' ||
    presentation.documentElement.getAttribute('saveSubsetFonts') !== '0' ||
    !faceNodes.some((item) => item.getAttribute('typeface') === provision.typeface) ||
    !embeddedFace ||
    !relationship ||
    embeddedFace.getAttributeNS(R_NS, 'id') !== relationship.getAttribute('Id') ||
    !defaultType
  )
    throw new Error('pptx_font_relationship_readback_failed');
  return {
    bytes,
    embedded: true,
    reason: 'embedded',
    typeface: provision.typeface,
    fontSha256: provision.sha256,
  };
};

export const assessPptxFontProvision = (
  provision: PptxFontProvision | null,
  selectedTypeface: string,
): PptxFontAssessment => {
  if (!provision) return { embeddable: false, reason: 'font_missing' };
  if (provision.typeface !== selectedTypeface)
    return { embeddable: false, reason: 'font_family_mismatch' };
  if (
    provision.bytes.byteLength > 32 * 1024 * 1024 ||
    sha256(provision.bytes) !== provision.sha256 ||
    !/^[a-f0-9]{64}$/.test(provision.licenseReceiptSha256) ||
    sha256(provision.licenseReceipt) !== provision.licenseReceiptSha256 ||
    !/^[a-f0-9]{64}$/.test(provision.copyrightNoticeSha256) ||
    sha256(provision.copyrightNotice) !== provision.copyrightNoticeSha256 ||
    !provision.licenseId.trim() ||
    !provision.sourceCommit.trim()
  )
    throw new Error('pptx_font_provision_receipt_invalid');
  const facts = inspectSfnt(provision.bytes);
  if (
    facts.family !== provision.typeface ||
    facts.variable ||
    facts.face.toLowerCase() !== provision.face.toLowerCase()
  )
    throw new Error('pptx_font_face_mismatch_or_variable');
  if (getFontRights(facts) === 'blocked')
    return { embeddable: false, reason: 'font_license_restricts_editing' };
  return { embeddable: true, reason: 'embedded' };
};
