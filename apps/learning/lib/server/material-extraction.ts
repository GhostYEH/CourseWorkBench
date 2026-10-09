import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { StudyError } from '@sew/study-contracts';
import type { Session } from './service';
import { assertScope, readAuthorizedDocumentBytes } from './service';
import {
  type MaterialExtractionPreview,
  materialExtractionConfirmSchema,
  materialExtractionRequestSchema,
} from '../material-extraction-contract';

const EXTRACTION_VERSION = 'source-extract-1';
const TOKEN_TTL_MS = 10 * 60_000;
const MAX_ARCHIVE_ENTRIES = 2500;
const MAX_ZIP_XML_PART_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_TOTAL_OUTPUT_BYTES = 48 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;
const MAX_BLOCKS = 2000;

interface ExtractedBlock {
  location: string;
  text: string;
}

interface PendingExtraction {
  session: Session;
  sourcePath: string;
  sourceName: string;
  format: 'pdf' | 'docx' | 'pptx' | 'xlsx';
  sourceSha256: string;
  sourceByteLength: number;
  blocks: ExtractedBlock[];
  extractedText: string;
  warnings: string[];
  expiresAt: number;
  importing: boolean;
}

const tokenState = globalThis as typeof globalThis & {
  __sewPendingMaterialExtractions?: Map<string, PendingExtraction>;
};
const pendingExtractions = (tokenState.__sewPendingMaterialExtractions ??= new Map());

const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const unsupported = (reason: string, message: string): StudyError =>
  new StudyError('MATERIAL_TYPE_UNSUPPORTED', { reason }, message);

const xmlText = (element: Element): string => {
  const result: string[] = [];
  const walk = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3 || child.nodeType === 4) result.push(child.nodeValue ?? '');
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(element);
  return result.join('').replace(/\s+/g, ' ').trim();
};

const nodeName = (element: Element): string =>
  (element.localName || element.nodeName.split(':').at(-1) || '').toLowerCase();

const children = (element: Element, name?: string): Element[] => {
  const result: Element[] = [];
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 1) continue;
    const childElement = child as Element;
    if (!name || nodeName(childElement) === name) result.push(childElement);
  }
  return result;
};

const containsNode = (parent: Element, target: Node): boolean => {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child === target || (child.nodeType === 1 && containsNode(child as Element, target)))
      return true;
  }
  return false;
};

const descendants = (element: Element, name: string): Element[] => {
  const result: Element[] = [];
  const walk = (parent: Element): void => {
    for (const child of children(parent)) {
      if (nodeName(child) === name) result.push(child);
      walk(child);
    }
  };
  walk(element);
  return result;
};

const parseXml = (bytes: Uint8Array, part: string): Document => {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unsupported('office_xml_not_utf8', `Office 文档 XML 编码无效：${part}`);
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source))
    throw unsupported(
      'office_xml_external_entity',
      '文档含 DTD 或实体声明，已拒绝以防止外部实体读取',
    );
  let parseFailed = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: () => {
        parseFailed = true;
      },
      fatalError: () => {
        parseFailed = true;
      },
    },
  }).parseFromString(source, 'application/xml');
  if (parseFailed || !document.documentElement)
    throw unsupported('office_xml_invalid', `Office 文档 XML 无法解析：${part}`);
  return document;
};

const textParts = (element: Element): string => {
  const formula = descendants(element, 'omath').concat(descendants(element, 'omathpara'));
  const text = xmlText(element);
  const formulas = formula.map((item) => xmlText(item)).filter(Boolean);
  return formulas.length
    ? `${text.replace(formulas.join(''), '').trim()}${text ? ' ' : ''}〔公式：${formulas.join('；')}〕`.trim()
    : text;
};

const tableCellText = (cell: Element): string =>
  descendants(cell, 'p').map(textParts).filter(Boolean).join('<br>').replace(/\|/g, '\\|');

const markdownTable = (table: Element, rowName: string, cellName: string): string => {
  const rows = descendants(table, rowName).map((row) => children(row, cellName).map(tableCellText));
  return rows
    .filter((row) => row.length > 0)
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
};

const safeZipPath = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 512 &&
  !name.startsWith('/') &&
  !name.includes('\\') &&
  !name.includes('\0') &&
  !name.split('/').some((part) => part === '..' || part === '.');

/** Stream only bounded XML parts; no archive member is written to disk. */
const readZipXmlParts = (bytes: Uint8Array): Map<string, Uint8Array> => {
  const wanted = (name: string): boolean =>
    name === '[Content_Types].xml' ||
    name === 'word/document.xml' ||
    name === 'word/numbering.xml' ||
    /^word\/(?:header|footer)\d+\.xml$/.test(name) ||
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name === 'xl/sharedStrings.xml' ||
    name === 'xl/styles.xml' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name) ||
    /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
    /\.rels$/i.test(name);
  const files = new Map<string, Uint8Array>();
  let totalOutput = 0;
  let entryCount = 0;
  let parseError: Error | null = null;
  const unzip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES || !safeZipPath(file.name)) {
      parseError = unsupported('office_archive_limits', 'Office 压缩包包含过多文件或无效路径');
      file.terminate();
      return;
    }
    if (!wanted(file.name)) return;
    if (file.originalSize !== undefined && file.originalSize > MAX_ZIP_XML_PART_BYTES) {
      parseError = unsupported('office_xml_part_too_large', 'Office 文档内容超出解析上限');
      file.terminate();
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) {
        parseError = unsupported('office_archive_corrupt', 'Office 压缩包内容损坏');
        return;
      }
      size += chunk.byteLength;
      totalOutput += chunk.byteLength;
      if (size > MAX_ZIP_XML_PART_BYTES || totalOutput > MAX_ZIP_TOTAL_OUTPUT_BYTES) {
        parseError = unsupported(
          'office_archive_expanded_too_large',
          'Office 压缩包解压内容超过安全上限',
        );
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) files.set(file.name, Buffer.concat(chunks, size));
    };
    try {
      file.start();
    } catch {
      parseError = unsupported(
        'office_archive_compression_unsupported',
        'Office 压缩包使用不支持的压缩方式',
      );
    }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    unzip.push(bytes, true);
  } catch {
    parseError ??= unsupported('office_archive_corrupt', 'Office 压缩包损坏或格式无效');
  }
  if (parseError) throw parseError;
  return files;
};

const assertOfficeType = (
  files: Map<string, Uint8Array>,
  format: 'docx' | 'pptx' | 'xlsx',
): void => {
  const contentTypes = files.get('[Content_Types].xml');
  if (!contentTypes) throw unsupported('office_content_types_missing', 'Office 文件缺少类型声明');
  const xml = parseXml(contentTypes, '[Content_Types].xml');
  const types = descendants(xml.documentElement, 'override')
    .map((item) => item.getAttribute('ContentType') ?? '')
    .join('\n');
  const marker =
    format === 'docx'
      ? 'wordprocessingml.document.main+xml'
      : format === 'pptx'
        ? 'presentationml.presentation.main+xml'
        : 'spreadsheetml.sheet.main+xml';
  if (!types.includes(marker))
    throw unsupported('office_type_mismatch', 'Office 文件类型与扩展名不匹配');
  for (const [name, part] of files) {
    if (!name.endsWith('.rels')) continue;
    const rels = parseXml(part, name);
    const external = descendants(rels.documentElement, 'relationship').some(
      (item) => item.getAttribute('TargetMode')?.toLowerCase() === 'external',
    );
    if (external)
      throw unsupported(
        'office_external_relationship',
        'Office 文档包含外部关系，已拒绝以避免跟随外部资源',
      );
  }
};

const extractDocx = (
  files: Map<string, Uint8Array>,
): { blocks: ExtractedBlock[]; warnings: string[] } => {
  assertOfficeType(files, 'docx');
  const documentBytes = files.get('word/document.xml');
  if (!documentBytes) throw unsupported('docx_document_missing', 'DOCX 文档主体缺失');
  const document = parseXml(documentBytes, 'word/document.xml');
  const body = descendants(document.documentElement, 'body')[0];
  if (!body) throw unsupported('docx_body_missing', 'DOCX 文档正文缺失');
  const blocks: ExtractedBlock[] = [];
  let paragraph = 0;
  let table = 0;
  for (const block of children(body)) {
    const type = nodeName(block);
    if (type === 'p') {
      paragraph += 1;
      const text = textParts(block);
      if (text) blocks.push({ location: `DOCX 段落 ${paragraph}`, text });
    } else if (type === 'tbl') {
      table += 1;
      const text = markdownTable(block, 'tr', 'tc');
      if (text) blocks.push({ location: `DOCX 表格 ${table}`, text });
    }
    if (blocks.length > MAX_BLOCKS)
      throw unsupported('document_block_limit', 'DOCX 段落或表格数量超过上限');
  }
  return {
    blocks,
    warnings: [
      'DOCX 位置按正文段落/表格编号；页码由 Word 排版决定，无法从静态文件稳定定位。',
      '仅导出 XML 中的段落次序；列表编号与复杂 OMML 公式版式可能不完整。',
      '嵌入图片、图表、页眉页脚、批注与修订视图不做 OCR 或解析。',
    ],
  };
};

const extractPptx = (
  files: Map<string, Uint8Array>,
): { blocks: ExtractedBlock[]; warnings: string[] } => {
  assertOfficeType(files, 'pptx');
  const names = [...files.keys()]
    .map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (names.length === 0) throw unsupported('pptx_slides_missing', 'PPTX 没有可读取的幻灯片');
  if (names.length > 500) throw unsupported('pptx_slide_limit', 'PPTX 幻灯片数量超过 500 页');
  const blocks: ExtractedBlock[] = [];
  for (const match of names) {
    const slideNumber = Number(match[1]);
    const path = match[0];
    const xml = parseXml(files.get(path)!, path);
    const tables = descendants(xml.documentElement, 'tbl');
    const tableSet = new Set(tables);
    let shape = 0;
    const spTree = descendants(xml.documentElement, 'sptree')[0] ?? xml.documentElement;
    for (const item of children(spTree)) {
      shape += 1;
      if (nodeName(item) === 'graphicframe') {
        const table = descendants(item, 'tbl')[0];
        if (table) {
          const text = markdownTable(table, 'tr', 'tc');
          if (text) blocks.push({ location: `PPTX 幻灯片 ${slideNumber} · 表格 ${shape}`, text });
          continue;
        }
      }
      const paragraphs = descendants(item, 'p').filter(
        (paragraph) => ![...tableSet].some((table) => containsNode(table, paragraph)),
      );
      const text = paragraphs.map(textParts).filter(Boolean).join('\n');
      if (text) blocks.push({ location: `PPTX 幻灯片 ${slideNumber} · 对象 ${shape}`, text });
      if (blocks.length > MAX_BLOCKS)
        throw unsupported('document_block_limit', 'PPTX 文本对象数量超过上限');
    }
  }
  return {
    blocks,
    warnings: [
      'PPTX 位置按幻灯片与文本对象编号；对象顺序不等同于完整视觉阅读顺序。',
      '公式结构只保留可读文本标记；复杂排版、主题样式与动画顺序不重建。',
      '图片、音视频、SmartArt、演讲者备注和嵌入对象不做 OCR 或解析。',
    ],
  };
};

const decodeSharedStrings = (files: Map<string, Uint8Array>): string[] => {
  const bytes = files.get('xl/sharedStrings.xml');
  if (!bytes) return [];
  const xml = parseXml(bytes, 'xl/sharedStrings.xml');
  return descendants(xml.documentElement, 'si').map((item) =>
    descendants(item, 't').map(xmlText).join(''),
  );
};

const extractXlsx = (
  files: Map<string, Uint8Array>,
): { blocks: ExtractedBlock[]; warnings: string[] } => {
  assertOfficeType(files, 'xlsx');
  const workbookBytes = files.get('xl/workbook.xml');
  const relationsBytes = files.get('xl/_rels/workbook.xml.rels');
  if (!workbookBytes || !relationsBytes)
    throw unsupported('xlsx_workbook_missing', 'XLSX 工作簿或关系表缺失');
  const workbook = parseXml(workbookBytes, 'xl/workbook.xml');
  const relations = parseXml(relationsBytes, 'xl/_rels/workbook.xml.rels');
  const targets = new Map<string, string>();
  for (const relationship of descendants(relations.documentElement, 'relationship')) {
    if (relationship.getAttribute('TargetMode')?.toLowerCase() === 'external')
      throw unsupported('xlsx_external_relationship', 'XLSX 包含外部关系，已拒绝读取');
    const id = relationship.getAttribute('Id');
    const target = relationship.getAttribute('Target');
    if (!id || !target) continue;
    const resolved = target.startsWith('/')
      ? target.slice(1)
      : posix.normalize(posix.join('xl', target));
    if (!safeZipPath(resolved) || !/^xl\/worksheets\/sheet\d+\.xml$/.test(resolved))
      throw unsupported('xlsx_sheet_target_invalid', 'XLSX 工作表关系路径无效');
    targets.set(id, resolved);
  }
  const sharedStrings = decodeSharedStrings(files);
  const sheets = descendants(workbook.documentElement, 'sheet');
  if (sheets.length === 0 || sheets.length > 200)
    throw unsupported('xlsx_sheet_limit', 'XLSX 工作表数量为空或超过 200 个');
  const blocks: ExtractedBlock[] = [];
  let totalCells = 0;
  const warnings = [
    'XLSX 保留工作表、单元格坐标、表格边界、公式文本和缓存结果；不会重算公式或保留显示格式。图表、绘图、宏与外部链接不执行。',
  ];
  for (const sheet of sheets) {
    const sheetName = (sheet.getAttribute('name') ?? '').replace(/[\[\]*?:/\\]/g, '_').slice(0, 31);
    const relId = sheet.getAttribute('r:id') ?? sheet.getAttribute('id') ?? '';
    const path = targets.get(relId);
    const sheetBytes = path ? files.get(path) : undefined;
    if (!sheetName || !path || !sheetBytes)
      throw unsupported('xlsx_sheet_missing', 'XLSX 某工作表内容缺失或关系无效');
    const xml = parseXml(sheetBytes, path);
    const cells = new Map<string, string>();
    let maxRow = 0;
    let maxColumn = 0;
    let sheetCellCount = 0;
    for (const cell of descendants(xml.documentElement, 'c')) {
      const address = cell.getAttribute('r') ?? '';
      const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address);
      if (!match) throw unsupported('xlsx_cell_address_invalid', 'XLSX 单元格坐标无效');
      const columnLetters = match[1]!;
      const row = Number(match[2]);
      let column = 0;
      for (const char of columnLetters) column = column * 26 + char.charCodeAt(0) - 64;
      if (row > 5000 || column > 200)
        throw unsupported('xlsx_sheet_dimensions_limit', 'XLSX 单元格范围超过安全上限');
      totalCells += 1;
      sheetCellCount += 1;
      if (totalCells > 10_000) throw unsupported('xlsx_cell_limit', 'XLSX 单元格总数超过 10,000');
      maxRow = Math.max(maxRow, row);
      maxColumn = Math.max(maxColumn, column);
      const valueElement = descendants(cell, 'v')[0];
      let value = valueElement ? xmlText(valueElement) : '';
      if (cell.getAttribute('t') === 's' && value) {
        const index = Number(value);
        value = Number.isSafeInteger(index) ? (sharedStrings[index] ?? '') : '';
      } else if (cell.getAttribute('t') === 'inlineStr') {
        value = descendants(cell, 't').map(xmlText).join('');
      }
      const formula = descendants(cell, 'f')[0];
      const formulaText = formula ? xmlText(formula) : '';
      if (formulaText) value = `${value}${value ? ' ' : ''}〔公式：=${formulaText}〕`;
      cells.set(`${row}:${column}`, value.replace(/\|/g, '\\|').slice(0, 20_000));
    }
    if (!sheetCellCount) continue;
    if (maxRow * maxColumn > 10_000)
      throw unsupported('xlsx_table_dimensions_limit', 'XLSX 工作表有效区域超过 10,000 个单元格');
    const columnName = (number: number): string => {
      let value = number;
      let name = '';
      while (value > 0) {
        value -= 1;
        name = String.fromCharCode(65 + (value % 26)) + name;
        value = Math.floor(value / 26);
      }
      return name;
    };
    const header = [
      '行',
      ...Array.from({ length: maxColumn }, (_, index) => columnName(index + 1)),
    ];
    const rows = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
    for (let row = 1; row <= maxRow; row += 1) {
      const values = [String(row)];
      for (let column = 1; column <= maxColumn; column += 1)
        values.push(cells.get(`${row}:${column}`) ?? '');
      rows.push(`| ${values.join(' | ')} |`);
    }
    blocks.push({
      location: `XLSX 工作表 ${sheetName} · A1 至 ${columnName(maxColumn)}${maxRow}`,
      text: rows.join('\n'),
    });
  }
  return { blocks, warnings };
};

const extractPdf = async (
  bytes: Uint8Array,
): Promise<{ blocks: ExtractedBlock[]; warnings: string[] }> => {
  if (bytes.byteLength < 8) throw unsupported('pdf_signature_invalid', 'PDF 文件过短或为空');
  const header = Buffer.from(bytes).subarray(0, 1024).toString('latin1');
  if (!header.includes('%PDF-')) throw unsupported('pdf_signature_invalid', 'PDF 文件签名无效');
  const loading = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    enableXfa: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    verbosity: 0,
  });
  let document: Awaited<typeof loading.promise> | null = null;
  try {
    document = await loading.promise;
    if (document.numPages < 1 || document.numPages > 500)
      throw unsupported('pdf_page_limit', 'PDF 页数为空或超过 500 页');
    const blocks: ExtractedBlock[] = [];
    let extractedCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const text = content.items
        .flatMap((item) =>
          'str' in item && typeof item.str === 'string'
            ? [item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ')]
            : [],
        )
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (text) {
        extractedCharacters += text.length;
        if (extractedCharacters > MAX_EXTRACTED_TEXT_CHARS)
          throw unsupported('document_text_limit', 'PDF 提取文本超过 100 万字符上限');
        blocks.push({ location: `PDF 第 ${pageNumber} 页`, text });
      }
      if (blocks.length > MAX_BLOCKS)
        throw unsupported('document_block_limit', 'PDF 页数超过段落解析上限');
    }
    if (blocks.length === 0)
      throw unsupported(
        'pdf_text_layer_missing',
        'PDF 未包含可提取文字；扫描件需要 OCR，本地导入不会伪造识别结果',
      );
    return {
      blocks,
      warnings: [
        'PDF 保留页面定位；多栏阅读顺序、版面表格与公式结构可能不完整，请在预览中人工核对。',
        '仅提取 PDF 文字层；扫描页、图片和图表不做 OCR。',
      ],
    };
  } catch (error) {
    if (error instanceof StudyError) throw error;
    throw unsupported(
      'pdf_parse_failed',
      'PDF 无法安全提取文字；加密、损坏或扫描件不会自动绕过或执行 OCR',
    );
  } finally {
    await loading.destroy().catch(() => undefined);
  }
};

const extractOffice = (
  bytes: Uint8Array,
  format: 'docx' | 'pptx' | 'xlsx',
): { blocks: ExtractedBlock[]; warnings: string[] } => {
  if (Buffer.from(bytes).readUInt32LE(0) !== 0x04034b50)
    throw unsupported('office_signature_invalid', 'Office 文件不是有效的 ZIP 容器');
  const files = readZipXmlParts(bytes);
  if (format === 'docx') return extractDocx(files);
  if (format === 'pptx') return extractPptx(files);
  return extractXlsx(files);
};

const joinExtractedText = (blocks: ExtractedBlock[]): string =>
  blocks
    .map(
      (block) =>
        `〔${block.location}〕\n${block.text
          .replace(/\r\n?/g, '\n')
          .replace(/\n{2,}/g, '\n')
          .trim()}`,
    )
    .join('\n\n');

const pruneExtractions = (now: number): void => {
  for (const [id, extraction] of pendingExtractions)
    if (extraction.expiresAt <= now && !extraction.importing) pendingExtractions.delete(id);
};

export const previewMaterialExtraction = async (
  raw: unknown,
): Promise<MaterialExtractionPreview> => {
  const parsedRequest = materialExtractionRequestSchema.safeParse(raw);
  if (!parsedRequest.success)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'material_extraction_request_invalid' });
  const request = parsedRequest.data;
  const session = assertScope(request.scope);
  pruneExtractions(Date.now());
  if (pendingExtractions.size >= 32)
    throw unsupported(
      'too_many_pending_extractions',
      '当前服务待确认文档数量已满，请先确认或稍后重试',
    );
  const currentForSession = [...pendingExtractions.values()].filter(
    (item) => item.session === session,
  );
  if (currentForSession.length >= 4)
    throw unsupported('too_many_pending_extractions', '待确认文档过多，请先确认或刷新页面');
  const source = readAuthorizedDocumentBytes(session, request.sourcePath);
  const format = source.extension as PendingExtraction['format'];
  const parsed =
    format === 'pdf' ? await extractPdf(source.bytes) : extractOffice(source.bytes, format);
  if (parsed.blocks.length === 0)
    throw unsupported('document_text_missing', '文件没有可提取文本，已拒绝空内容导入');
  const extractedText = joinExtractedText(parsed.blocks);
  if (extractedText.length > MAX_EXTRACTED_TEXT_CHARS)
    throw unsupported('document_text_limit', '提取文本超过 100 万字符上限');
  const id = randomBytes(32).toString('base64url');
  const sha = sha256(source.bytes);
  pendingExtractions.set(id, {
    session,
    sourcePath: request.sourcePath,
    sourceName: source.originalName,
    format,
    sourceSha256: sha,
    sourceByteLength: source.bytes.byteLength,
    blocks: parsed.blocks,
    extractedText,
    warnings: parsed.warnings,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    importing: false,
  });
  return {
    extractionId: id,
    source: {
      name: source.originalName,
      format,
      sha256: sha,
      byteLength: source.bytes.byteLength,
    },
    blocks: parsed.blocks,
    extractedText,
    warnings: parsed.warnings,
  };
};

export const confirmMaterialExtraction = (
  raw: unknown,
): ReturnType<Session['store']['importMaterial']> => {
  const parsedRequest = materialExtractionConfirmSchema.safeParse(raw);
  if (!parsedRequest.success)
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'material_extraction_confirmation_invalid',
    });
  const request = parsedRequest.data;
  const session = assertScope(request.scope);
  const extraction = pendingExtractions.get(request.extractionId);
  if (
    !extraction ||
    extraction.session !== session ||
    extraction.expiresAt <= Date.now() ||
    extraction.importing
  ) {
    pendingExtractions.delete(request.extractionId);
    throw unsupported(
      'extraction_token_invalid',
      '提取预览已过期、已使用或不属于当前项目，请重新选择文件',
    );
  }
  extraction.importing = true;
  try {
    const current = readAuthorizedDocumentBytes(session, extraction.sourcePath);
    if (
      current.extension !== extraction.format ||
      current.bytes.byteLength !== extraction.sourceByteLength ||
      sha256(current.bytes) !== extraction.sourceSha256
    )
      throw new StudyError(
        'VERSION_CONFLICT',
        { reason: 'source_changed_after_extraction' },
        '源文件在预览后发生变化，请重新提取',
      );
    const extractedBytes = Buffer.from(extraction.extractedText, 'utf8');
    const result = session.store.importMaterial({
      projectId: session.projectId,
      displayName: request.displayName,
      materialType: 'md',
      readableLocation: request.readableLocation,
      rawText: extraction.extractedText,
      rawBytes: extractedBytes,
      originalName: `${extraction.sourceName}.extracted.md`,
      sourceExtraction: {
        format: extraction.format,
        originalName: extraction.sourceName,
        bytes: current.bytes,
        extractionVersion: EXTRACTION_VERSION,
        locations: extraction.blocks.map((block: ExtractedBlock, index: number) => ({
          ordinal: index + 1,
          label: block.location,
        })),
      },
    });
    pendingExtractions.delete(request.extractionId);
    return result;
  } catch (error) {
    pendingExtractions.delete(request.extractionId);
    throw error;
  }
};
