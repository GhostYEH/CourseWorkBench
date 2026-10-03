/** Request-scoped RSC reads. API handlers keep using uncached reads after writes. */
import { cache } from 'react';
import type { Session } from './service';
import { buildWorkbenchState } from './state';
import { buildKnowledgeView } from './views';

export const readWorkbenchMaterials = cache((session: Session) => session.store.listMaterials());
export const readWorkbenchProposals = cache((session: Session) => session.store.listProposals());
export const readWorkbenchKnowledge = cache(buildKnowledgeView);
export const readWorkbenchState = cache((session: Session) => buildWorkbenchState(session, {
  materials: readWorkbenchMaterials(session),
  proposals: readWorkbenchProposals(session),
  knowledge: readWorkbenchKnowledge(session),
}));
