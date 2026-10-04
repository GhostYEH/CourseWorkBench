import { z } from 'zod';
import { StudyError } from '@sew/study-contracts';
import { parseQuery, route, ok } from '../../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../../lib/server/service';
import { toMaterialDto, toSegmentDto } from '../../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  // `?revision=` 的空串会被 z.coerce.number() 变成 0 并触发 positive() 失败；
  // 这里把空串/缺省统一视为「未指定」，由存储层取最新版本。
  revision: z.preprocess(
    (value) => (value === '' || value === undefined ? undefined : value),
    z.coerce.number().int().positive().optional(),
  ),
});

/** 读取指定材料版本的段落原文，用于来源定位与审核。 */
const readMaterial = route(async (request: Request, context: { params: Promise<{ materialId: string }> }) => {
  const session = requireSession();
  const { materialId } = await context.params;
  assertScope({ projectId: session.projectId, generation: session.generation });
  const query = parseQuery(request, querySchema);

  const material = session.store.getMaterial(materialId, query.revision);
  if (!material) throw new StudyError('MATERIAL_NOT_FOUND', { materialId });

  return ok({
    material: toMaterialDto(material),
    versions: session.store.listMaterialVersions(materialId).map(toMaterialDto),
    segments: session.store
      .getSegments(material.materialId, material.revision)
      .map(toSegmentDto),
  });
});

export const GET = async (...args: Parameters<typeof readMaterial>) => {
  const response = await readMaterial(...args);
  response.headers.set('cache-control', 'no-store');
  return response;
};
