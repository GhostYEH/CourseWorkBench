/** Request-scoped RSC reads. API handlers keep using uncached reads after writes. */
import { cache } from 'react';
import type { Session } from './service';
import { buildWorkbenchState } from './state';
import { buildKnowledgeView } from './views';
import { toQuestionListItemDto, toSegmentDto, toSyllabusItemDto } from './dto';

export const readWorkbenchMaterials = cache((session: Session) => session.store.listMaterials());
export const readWorkbenchProposals = cache((session: Session) => session.store.listProposals());
export const readWorkbenchKnowledge = cache(buildKnowledgeView);
export const readWorkbenchState = cache((session: Session) => buildWorkbenchState(session, {
  materials: readWorkbenchMaterials(session),
  proposals: readWorkbenchProposals(session),
  knowledge: readWorkbenchKnowledge(session),
}));

/**
 * 候选与考纲条目可选的段落：覆盖全部材料的最新版本。
 *
 * 不能只取第一条材料：项目里同时有考纲、教材与讲义时，固定在 materials[0]
 * 会让审核人无法为其余材料提候选。
 */
export const readSegmentChoices = cache((session: Session) =>
  readWorkbenchMaterials(session).flatMap((material) =>
    session.store
      .getSegments(material.materialId, material.revision)
      .map((segment) => ({
        ...toSegmentDto(segment),
        materialId: segment.materialId,
        revision: segment.revision,
        materialName: material.displayName,
      })),
  ),
);

export const readSyllabusItems = cache((session: Session) =>
  session.store.listSyllabusItems().map(toSyllabusItemDto),
);

/** 项目树只需要题目身份标签：这里固定输出列表 DTO，不含答案与解析。 */
export const readWorkbenchQuestions = cache((session: Session) =>
  session.store.listQuestions().map(toQuestionListItemDto),
);

/** 最近一次 run 的可见快照；事件只读取已提交序号。 */
export const readWorkbenchRun = cache((session: Session) => {
  const run = session.store.getLatestRun();
  if (!run) return null;
  const events = session.store.listRunEvents(run.runId);
  const last = events[events.length - 1];
  return {
    runId: run.runId,
    state: run.state,
    frozen: run.frozen,
    lastSeq: last?.seq ?? 0,
  };
});
