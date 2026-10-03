import { route, ok } from '../../../../lib/server/http';
import { requireSession } from '../../../../lib/server/service';
import { toKnowledgePointDto } from '../../../../lib/server/dto';
import { buildKnowledgeView } from '../../../../lib/server/views';

export const dynamic = 'force-dynamic';

/** 权威知识点表：`knowledge_points` 是已确认教学知识点的唯一权威源。 */
export const GET = route(() => {
  const session = requireSession();
  const view = buildKnowledgeView(session);
  const knowledge = view.rows.map((row) => ({
    ...toKnowledgePointDto(row),
    admission: view.admissionFor(row.knowledgeId),
  }));
  return ok({ knowledge });
});
