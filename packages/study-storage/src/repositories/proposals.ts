/**
 * 知识候选与人工审核（repository）。
 *
 * AI 只写候选；「通过」必须经机械复验 + 语义确认后，才在同一事务内写入权威表。
 * 候选状态更新与权威知识点写入由调用方注入的 `insertKnowledgePoint` 完成，
 * 二者共用同一个 `SqlDatabase` 事务，不能拆成两个独立事务。
 */

import { StudyError, newId, type ReviewDecision } from '@sew/study-contracts';
import type { RecordScope } from '@sew/study-contracts';
import {
  decideProposal,
  runMechanicalCheck,
  type MechanicalCheckResult,
  type RegisteredSegment,
} from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import type { InsertKnowledgePointInput } from './knowledge';
import {
  defaultJsonPolicy,
  mapProposal,
  type CreateProposalInput,
  type EvidenceStored,
  type KnowledgeRow,
  type ProposalRow,
  type ReviewOutcome,
  type Row,
} from './types';

export interface ProposalWriteDeps {
  scope: RecordScope;
  lookupSegment: (materialId: string, revision: number, segmentId: string) => RegisteredSegment | undefined;
  currentRevisions: Record<string, number>;
  knownKnowledgeIds: ReadonlySet<string>;
}

export interface ApplyReviewDeps extends ProposalWriteDeps {
  insertKnowledgePoint: (input: InsertKnowledgePointInput) => KnowledgeRow;
}

export interface ApplyReviewInput {
  proposalId: string;
  decision: ReviewDecision;
  expectedRevision: number;
  semanticReviewed: boolean;
  note?: string;
}

export class ProposalsRepository {
  constructor(private readonly db: SqlDatabase) {}

  createProposal(input: CreateProposalInput, deps: ProposalWriteDeps): ProposalRow {
    const scope = input.recordScope ?? 'formal';
    if (scope !== deps.scope) throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'record_scope_mismatch' });
    const mechanical = runMechanicalCheck({
      evidence: input.evidence,
      lookupSegment: deps.lookupSegment,
      currentRevisions: deps.currentRevisions,
      knownKnowledgeIds: deps.knownKnowledgeIds,
      prerequisites: input.prerequisites,
    });

    const enriched: EvidenceStored[] = input.evidence.map((ref) => {
      const located = mechanical.excerpts.find(
        (e) =>
          e.ref.materialId === ref.materialId &&
          e.ref.segmentId === ref.segmentId &&
          e.ref.revision === ref.revision,
      );
      return located
        ? { ...ref, fingerprint: located.fingerprint, excerpt: located.excerpt }
        : { ...ref };
    });

    const proposalId = newId<'proposal'>('prop');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO proposals (proposal_id, name, concept, conditions, scope_status, prerequisites_json, evidence_json, acceptance, priority, proposed_by, status, mechanical_json, created_at, revision, record_scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?)`,
      )
      .run(
        proposalId,
        input.name,
        input.concept,
        input.conditions,
        input.scopeStatus,
        encodeJson(input.prerequisites),
        encodeJson(enriched),
        input.acceptance,
        input.priority,
        input.proposedBy,
        encodeJson({ passed: mechanical.passed, checks: mechanical.checks }),
        now,
        scope,
      );

    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new StudyError('INTERNAL', { proposalId });
    return proposal;
  }

  getProposal(proposalId: string, scope?: RecordScope): ProposalRow | null {
    const statement = scope
      ? this.db.prepare('SELECT * FROM proposals WHERE proposal_id = ? AND record_scope = ?')
      : this.db.prepare('SELECT * FROM proposals WHERE proposal_id = ?');
    const row = (scope ? statement.get(proposalId, scope) : statement.get(proposalId)) as
      | Row
      | undefined;
    return row ? mapProposal(row, defaultJsonPolicy) : null;
  }

  listProposals(status?: ProposalRow['status'], scope: RecordScope = 'formal'): ProposalRow[] {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM proposals WHERE status = ? AND record_scope = ? ORDER BY created_at DESC').all(status, scope)
        : this.db.prepare('SELECT * FROM proposals WHERE record_scope = ? ORDER BY created_at DESC').all(scope)
    ) as Row[];
    return rows.map((row) => mapProposal(row, defaultJsonPolicy));
  }

  /**
   * 人工审核：先机械复验、再要求语义确认，最后在事务内写权威表。
   * 用户点击「通过」不能绕过缺失来源。
   */
  applyReview(input: ApplyReviewInput, deps: ApplyReviewDeps): ReviewOutcome {
    return this.applyReviewForScope(input, deps, 'formal', 'user_semantic');
  }

  applyDemoAuthorReview(input: ApplyReviewInput, deps: ApplyReviewDeps): ReviewOutcome {
    return this.applyReviewForScope(input, deps, 'demo', 'demo_author');
  }

  private applyReviewForScope(
    input: ApplyReviewInput,
    deps: ApplyReviewDeps,
    scope: RecordScope,
    provenance: 'user_semantic' | 'demo_author',
  ): ReviewOutcome {
    if (deps.scope !== scope) throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'record_scope_mismatch' });
    const proposal = this.getProposal(input.proposalId, scope);
    if (!proposal) throw new StudyError('NOT_FOUND', { proposalId: input.proposalId });
    if (proposal.status === 'approved' || proposal.status === 'rejected') {
      throw new StudyError('STEP_ALREADY_COMMITTED', { proposalId: proposal.proposalId, status: proposal.status });
    }

    // 复验机械检查：材料可能已更新，旧候选不能凭历史结论通过。
    const recheck: MechanicalCheckResult = runMechanicalCheck({
      evidence: proposal.evidence,
      lookupSegment: deps.lookupSegment,
      currentRevisions: deps.currentRevisions,
      knownKnowledgeIds: deps.knownKnowledgeIds,
      prerequisites: proposal.prerequisites,
    });

    const decision = decideProposal({
      decision: input.decision,
      expectedRevision: input.expectedRevision,
      currentRevision: proposal.revision,
      mechanical: recheck,
      semanticReviewed: input.semanticReviewed,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });

    const now = new Date().toISOString();
    let created: KnowledgeRow | null = null;

    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE proposals SET status = ?, review_note = ?, reviewed_at = ?, revision = revision + 1, mechanical_json = ?, review_provenance = ? WHERE proposal_id = ? AND record_scope = ?',
        )
        .run(
          decision.status,
          decision.note,
          now,
          encodeJson({ passed: recheck.passed, checks: recheck.checks }),
          decision.createsKnowledgePoint ? provenance : null,
          proposal.proposalId,
          scope,
        );

      if (!decision.createsKnowledgePoint) return;

      const evidence: EvidenceStored[] = recheck.excerpts.map((e) => ({
        materialId: e.ref.materialId,
        revision: e.ref.revision,
        segmentId: e.ref.segmentId,
        use: e.ref.use,
        fingerprint: e.fingerprint,
        excerpt: e.excerpt,
      }));

      created = deps.insertKnowledgePoint({
        knowledgeId: newId<'knowledge'>('kp'),
        name: proposal.name,
        concept: proposal.concept,
        conditions: proposal.conditions,
        scopeStatus: proposal.scopeStatus,
        prerequisites: proposal.prerequisites,
        evidence,
        acceptance: proposal.acceptance,
        priority: proposal.priority,
        originProposalId: proposal.proposalId,
        recordScope: scope,
        reviewProvenance: provenance,
        now,
      });
    });

    const updated = this.getProposal(proposal.proposalId, scope);
    if (!updated) throw new StudyError('INTERNAL', { proposalId: proposal.proposalId });
    return { proposal: updated, knowledgePoint: created, requiresSemanticReview: !input.semanticReviewed };
  }
}
