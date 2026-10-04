import { StudyError } from '@sew/study-contracts';
import { materialRawQuerySchema } from '@sew/study-contracts';
import { parseQuery, route, ok } from '../../../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../../../lib/server/service';

export const dynamic = 'force-dynamic';

/** 归档原文与段落定位信息；未归档的原文不伪造，只返回明确状态。 */
const toSpanDto = (
  row: {
    segmentId: string;
    text: string;
    rawStartByte: number | null;
    rawEndByte: number | null;
    rawLineStart: number | null;
    rawLineEnd: number | null;
  },
  charOffsetOf: (byteOffset: number) => number,
) => {
  if (
    row.rawStartByte === null || row.rawEndByte === null ||
    row.rawLineStart === null || row.rawLineEnd === null
  ) {
    return null;
  }
  return {
    segmentId: row.segmentId,
    text: row.text,
    startByte: row.rawStartByte,
    endByte: row.rawEndByte,
    lineStart: row.rawLineStart,
    lineEnd: row.rawLineEnd,
    startChar: charOffsetOf(row.rawStartByte),
    endChar: charOffsetOf(row.rawEndByte),
  };
};

/**
 * 读取某材料版本归档的原始文本，可附带一个段落用于定位。
 *
 * 段落区间按 UTF-8 字节计，与服务返回的 `rawText` 同属一份原始字节；
 * 界面据此高亮段落，不能用规范化文本的偏移代替。
 */
const readRaw = route(async (request: Request, context: { params: Promise<{ materialId: string }> }) => {
  const session = requireSession();
  const { materialId } = await context.params;
  assertScope({ projectId: session.projectId, generation: session.generation });
  const query = parseQuery(request, materialRawQuerySchema);
  const material = session.store.getMaterial(materialId, query.revision);
  if (!material) throw new StudyError('MATERIAL_NOT_FOUND', { materialId, revision: query.revision });

  if (material.rawArchive.state !== 'archived') {
    return ok({
      materialId,
      revision: query.revision,
      archive: material.rawArchive,
      rawText: null,
      segment: null,
    });
  }

  const { bytes } = session.store.readMaterialRaw(materialId, query.revision);
  let rawText: string;
  try {
    // 与导入时同一解码方式：保留 BOM，界面看到的原文才与归档字节逐字相同。
    rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StudyError(
      'MATERIAL_RAW_UNVERIFIED',
      { materialId, revision: query.revision, reason: 'invalid_utf8' },
      '归档的原始字节不是有效 UTF-8，已拒绝按原文使用',
    );
  }
  const view = Buffer.from(bytes);
  const charOffsetOf = (byteOffset: number): number => view.subarray(0, byteOffset).toString('utf8').length;

  return ok({
    materialId,
    revision: query.revision,
    archive: material.rawArchive,
    rawText,
    segment: query.segmentId
      ? toSpanDto(session.store.getSegmentSpan(materialId, query.revision, query.segmentId), charOffsetOf)
      : null,
  });
});

export const GET = async (...args: Parameters<typeof readRaw>) => {
  const response = await readRaw(...args);
  response.headers.set('cache-control', 'no-store');
  return response;
};
