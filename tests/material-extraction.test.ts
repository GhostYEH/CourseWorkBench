import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipFixture } from './helpers/office-zip-fixture';
import {
  authorizePaths,
  closeProject,
  openProjectFromDisk,
} from '../apps/learning/lib/server/service';
import {
  previewMaterialExtraction,
  confirmMaterialExtraction,
} from '../apps/learning/lib/server/material-extraction';

const docx = (document: string): Uint8Array =>
  zipFixture({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': document,
  });

const pptx = (slide: string): Uint8Array =>
  zipFixture({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    'ppt/slides/slide1.xml': slide,
  });

const xlsx = (): Uint8Array =>
  zipFixture({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="成绩表" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>学生</t></si><si><t>分数</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>小明</t></is></c><c r="B2"><f>SUM(1,2)</f><v>3</v></c></row></sheetData></worksheet>',
  });

const pdf = (text: string): Uint8Array => {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(`BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`, 'ascii')} >>\nstream\nBT /F1 18 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, 'ascii'));
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source, 'ascii');
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source, 'ascii');
};

describe('authorized document extraction and source tracking', () => {
  let directory: string;
  let session: ReturnType<typeof openProjectFromDisk>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sew-material-extract-'));
    session = openProjectFromDisk(directory);
  });
  afterEach(() => {
    closeProject();
    rmSync(directory, { recursive: true, force: true });
  });

  it('extracts PDF text with page locations and rejects scan-only documents without OCR claims', async () => {
    const path = join(directory, 'lesson.pdf');
    writeFileSync(path, pdf('Vector text layer'));
    const scope = { projectId: session.projectId, generation: session.generation };
    authorizePaths([path]);
    const preview = await previewMaterialExtraction({ scope, sourcePath: path });
    expect(preview).toMatchObject({ source: { format: 'pdf', name: 'lesson.pdf' } });
    expect(preview.blocks[0]).toMatchObject({ location: 'PDF 第 1 页' });
    expect(preview.extractedText).toContain('Vector text layer');
    expect(preview.warnings.join(' ')).toContain('不做 OCR');

    writeFileSync(path, pdf(''));
    await expect(previewMaterialExtraction({ scope, sourcePath: path })).rejects.toThrow(
      '未包含可提取文字',
    );
  });

  it('preserves DOCX paragraph/table boundaries and serializes formula text explicitly', async () => {
    const path = join(directory, 'lesson.docx');
    writeFileSync(
      path,
      docx(
        '<w:document xmlns:w="urn:w" xmlns:m="urn:m"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>概念</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>定义</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
      ),
    );
    authorizePaths([path]);
    const preview = await previewMaterialExtraction({
      scope: { projectId: session.projectId, generation: session.generation },
      sourcePath: path,
    });
    expect(preview.blocks.map((block) => block.location)).toEqual([
      'DOCX 段落 1',
      'DOCX 段落 2',
      'DOCX 表格 1',
    ]);
    expect(preview.extractedText).toContain('〔公式：x+1〕');
    expect(preview.extractedText).toContain('| 概念 | 定义 |');
  });

  it('extracts PPTX shape text and keeps native slide tables as Markdown cells', async () => {
    const path = join(directory, 'lesson.pptx');
    writeFileSync(
      path,
      pptx(
        '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:txBody><a:p><a:r><a:t>标题内容</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>列一</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>列二</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame></p:spTree></p:cSld></p:sld>',
      ),
    );
    authorizePaths([path]);
    const preview = await previewMaterialExtraction({
      scope: { projectId: session.projectId, generation: session.generation },
      sourcePath: path,
    });
    expect(preview.blocks.map((block) => block.location)).toEqual([
      'PPTX 幻灯片 1 · 对象 3',
      'PPTX 幻灯片 1 · 表格 4',
    ]);
    expect(preview.extractedText).toContain('标题内容');
    expect(preview.extractedText).toContain('| 列一 | 列二 |');
  });

  it('preserves XLSX sheet coordinates, shared strings and formula/cache values', async () => {
    const path = join(directory, 'results.xlsx');
    writeFileSync(path, xlsx());
    authorizePaths([path]);
    const preview = await previewMaterialExtraction({
      scope: { projectId: session.projectId, generation: session.generation },
      sourcePath: path,
    });
    expect(preview.blocks[0]?.location).toBe('XLSX 工作表 成绩表 · A1 至 B2');
    expect(preview.extractedText).toContain('学生');
    expect(preview.extractedText).toContain('〔公式：=SUM(1,2)〕');
    expect(preview.extractedText).toContain('小明');
  });

  it('rejects zip bombs before unbounded expansion and rejects external relationships', async () => {
    const path = join(directory, 'large.docx');
    const hugeDocument = `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${'x'.repeat(9 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`;
    writeFileSync(path, docx(hugeDocument));
    authorizePaths([path]);
    const scope = { projectId: session.projectId, generation: session.generation };
    await expect(previewMaterialExtraction({ scope, sourcePath: path })).rejects.toThrow(
      '解析上限',
    );

    const dishonestSize = Buffer.from(docx(hugeDocument));
    const entryName = Buffer.from('word/document.xml');
    const localNameOffset = dishonestSize.indexOf(entryName);
    const centralNameOffset = dishonestSize.lastIndexOf(entryName);
    expect(localNameOffset).toBeGreaterThan(30);
    expect(centralNameOffset).toBeGreaterThan(localNameOffset);
    dishonestSize.writeUInt32LE(1, localNameOffset - 30 + 22);
    dishonestSize.writeUInt32LE(1, centralNameOffset - 46 + 24);
    writeFileSync(path, dishonestSize);
    await expect(previewMaterialExtraction({ scope, sourcePath: path })).rejects.toThrow(
      '解压内容超过安全上限',
    );

    writeFileSync(
      path,
      zipFixture({
        '[Content_Types].xml':
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        'word/document.xml':
          '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>内容</w:t></w:r></w:p></w:body></w:document>',
        'word/_rels/document.xml.rels':
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="https://example.invalid/source" TargetMode="External"/></Relationships>',
      }),
    );
    await expect(previewMaterialExtraction({ scope, sourcePath: path })).rejects.toThrow(
      '外部关系',
    );
  });

  it('requires a same-session one-use token and rechecks exact source bytes before import', () => {
    const path = join(directory, 'source.docx');
    const bytes = docx(
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>只可信的服务端文本</w:t></w:r></w:p></w:body></w:document>',
    );
    writeFileSync(path, bytes);
    authorizePaths([path]);
    const scope = { projectId: session.projectId, generation: session.generation };
    return previewMaterialExtraction({ scope, sourcePath: path }).then((preview) => {
      expect(() =>
        confirmMaterialExtraction({
          scope,
          extractionId: preview.extractionId,
          displayName: 'ignored',
          extractedText: 'attacker supplied text',
        }),
      ).toThrow();
      writeFileSync(
        path,
        docx(
          '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>changed</w:t></w:r></w:p></w:body></w:document>',
        ),
      );
      expect(() =>
        confirmMaterialExtraction({
          scope,
          extractionId: preview.extractionId,
          displayName: 'source.docx',
        }),
      ).toThrow('发生变化');
      expect(session.store.listMaterials()).toHaveLength(0);
    });
  });

  it('archives the exact confirmed binary and stores trusted page locations beside extracted segments', async () => {
    const path = join(directory, 'confirmed.docx');
    const original = docx(
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>来源段落</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>',
    );
    writeFileSync(path, original);
    authorizePaths([path]);
    const scope = { projectId: session.projectId, generation: session.generation };
    const preview = await previewMaterialExtraction({ scope, sourcePath: path });
    const result = confirmMaterialExtraction({
      scope,
      extractionId: preview.extractionId,
      displayName: 'confirmed.docx',
    });
    const extractedOriginal = session.store.readMaterialExtractionOriginal(
      result.material.materialId,
      result.material.revision,
    );
    expect(extractedOriginal?.receipt).toMatchObject({
      format: 'docx',
      originalName: 'confirmed.docx',
      locations: [
        { ordinal: 1, label: 'DOCX 段落 1' },
        { ordinal: 2, label: 'DOCX 段落 2' },
      ],
    });
    expect(extractedOriginal?.bytes).toEqual(Uint8Array.from(original));
    expect(result.segments.map((segment) => segment.text)).toEqual([
      '〔DOCX 段落 1〕\n来源段落',
      '〔DOCX 段落 2〕\n第二段',
    ]);
    expect(() =>
      confirmMaterialExtraction({
        scope,
        extractionId: preview.extractionId,
        displayName: 'replay',
      }),
    ).toThrow('已使用');
  });
});
