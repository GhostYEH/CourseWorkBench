import type { CreateProposalInput, StudyStore } from '@sew/study-storage';

type VerifiedKnowledgeSeed = Pick<
  CreateProposalInput,
  'projectId' | 'name' | 'concept' | 'evidence'
> &
  Partial<Omit<CreateProposalInput, 'projectId' | 'name' | 'concept' | 'evidence'>>;

/** Use for prerequisites of another behavior; review-specific tests keep their own commands. */
export const seedVerifiedKnowledge = (store: StudyStore, input: VerifiedKnowledgeSeed) => {
  const proposal = store.createProposal({
    conditions: '',
    scopeStatus: 'in_syllabus',
    prerequisites: [],
    acceptance: '',
    priority: 'medium',
    proposedBy: 'ai',
    ...input,
  });
  const review = store.applyReview({
    proposalId: proposal.proposalId,
    expectedRevision: proposal.revision,
    decision: 'approved',
    semanticReviewed: true,
  });
  if (!review.knowledgePoint)
    throw new Error('Verified knowledge seed did not create a knowledge point');
  return { proposal, knowledge: review.knowledgePoint };
};
