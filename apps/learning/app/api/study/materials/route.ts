import { materialImportSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import {
  assertMaterialSize,
  assertScope,
  readAuthorizedFile,
  requireSession,
} from '../../../../lib/server/service';
import { toMaterialDto, toSegmentDto } from '../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

/** 材料列表：只返回最新版本，附带引用计数供删除前检查。 */
export const GET = route(() => {
  const session = requireSession();
  return ok({ materials: session.store.listMaterials().map(toMaterialDto) });
});

/**
 * 导入材料。导入模式用 `mode` 判别联合表达：
 * - `file`：`sourcePath` 只作为主进程已授权路径使用，未授权一律拒绝；
 * - `text`：直接给出正文，仍走同一套规范化与指纹。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, materialImportSchema);
  const session = assertScope(body.scope);

  // 两种导入模式共用同一字节上限：file 在读取前按磁盘大小拦截，
  // text 按 UTF-8 字节数拦截，超限返回可判定错误而不是写入巨型材料。
  let rawText: string;
  if (body.mode === 'file') {
    rawText = readAuthorizedFile(session, body.sourcePath);
  } else {
    assertMaterialSize(Buffer.byteLength(body.rawText, 'utf8'));
    rawText = body.rawText;
  }

  const result = session.store.importMaterial({
    projectId: session.projectId,
    displayName: body.displayName,
    materialType: body.type,
    readableLocation: body.readableLocation,
    rawText,
  });

  return ok({
    material: toMaterialDto(result.material),
    segments: result.segments.map(toSegmentDto),
    /** 受影响并转为已失效的知识点，界面需要明确展示。 */
    invalidated: result.invalidated,
  });
});
