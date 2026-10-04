import { StudyError, syllabusItemCreateSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import { toSyllabusItemDto } from '../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

/**
 * 考纲原子项。
 *
 * GET 返回条目与按条目计算的覆盖情况；POST 登记新条目。
 * 覆盖分母是登记条目数而不是知识点条数，重复的考纲编号会被拒绝登记。
 */
export const GET = route(() => {
  const session = requireSession();
  return ok({
    items: session.store.listSyllabusItems().map(toSyllabusItemDto),
    coverage: session.store.syllabusCoverage(),
  });
});

/**
 * 登记考纲条目：必须绑定到已登记材料版本的段落，条目内至少一个必要要素。
 * 只经受控界面进入，不注册为 agent 可调用工具。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, syllabusItemCreateSchema);
  const session = assertScope(body.scope);
  const material = session.store.getMaterial(body.source.materialId, body.source.revision);
  if (!material) {
    throw new StudyError('SYLLABUS_SOURCE_NOT_LOCATABLE', {
      reason: 'material_version_not_found',
      materialId: body.source.materialId,
      revision: body.source.revision,
    });
  }
  const created = session.store.createSyllabusItem({
    code: body.code,
    label: body.label,
    requirements: body.requirements,
    source: body.source,
    recordScope: 'formal',
  });
  return ok({ item: toSyllabusItemDto(created), coverage: session.store.syllabusCoverage() });
});
