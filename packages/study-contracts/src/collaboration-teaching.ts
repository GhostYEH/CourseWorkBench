import { z } from 'zod';
import { learnerUidSchema } from './learner-profile';
import { collabEventSchema, collabText } from './classroom-collaboration';
import { classroomBoardPublicContentSchema } from './classroom-board';

const id = z.string().min(1).max(200);

/**
 * 公共教学命令。
 *
 * 两条来源纪律贯穿所有操作：
 * - `speak` 只能引用**当前场景**知识点关联的冻结已审核 `statementId`；
 *   `write` 必须引用独立的人工板书审核回执，不能单凭陈述 ID 获准，
 *   调用方不能凭空塞任意正文；
 * - `focus`/`laser`/`erase` 只能指向当前冻结课件里**真实存在**的元素/已写内容。
 *
 * 协议 5 增加独立板书正文审核回执，再允许 `write` 引用回执。
 */
export const collabTeachingOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('speak'), statementId: id }).strict(),
  z
    .object({
      kind: z.literal('review-board-content'),
      statementId: id,
      content: classroomBoardPublicContentSchema,
      semanticReviewed: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('write'),
      statementId: id,
      content: classroomBoardPublicContentSchema,
      reviewEventId: id,
    })
    .strict(),
  z.object({ kind: z.literal('focus'), elementId: id }).strict(),
  z.object({ kind: z.literal('laser'), elementId: id }).strict(),
  z.object({ kind: z.literal('clear-board') }).strict(),
  z.object({ kind: z.literal('undo-board'), actionEventId: id }).strict(),
  z.object({ kind: z.literal('replay-board'), actionEventId: id }).strict(),
  z.object({ kind: z.literal('erase'), actionEventId: id }).strict(),
  z.object({ kind: z.literal('wait'), targetUid: learnerUidSchema }).strict(),
  z.object({ kind: z.literal('acknowledge'), waitEventId: id }).strict(),
  z.object({ kind: z.literal('release-wait'), waitEventId: id }).strict(),
  z.object({ kind: z.literal('cancel-wait'), waitEventId: id }).strict(),
]);
export type CollabTeachingOperation = z.infer<typeof collabTeachingOperationSchema>;

export const collabTeachingCommandSchema = z
  .object({
    roomId: id,
    actorUid: learnerUidSchema,
    sceneId: id,
    expectedRevision: z.number().int().positive(),
    expectedSeq: z.number().int().positive(),
    eventId: id,
    requestId: id,
    operation: collabTeachingOperationSchema,
  })
  .strict();
export type CollabTeachingCommandInput = z.infer<typeof collabTeachingCommandSchema>;

/** 已写进公共白板的一条内容：来源是当前场景的已审核陈述。 */
const boardContentSchema = z
  .object({
    eventId: id,
    seq: z.number().int().positive(),
    statementId: id,
    content: classroomBoardPublicContentSchema,
    reviewEventId: id.optional(),
  })
  .strict();
export type CollabBoardContentDto = z.infer<typeof boardContentSchema>;

const boardReviewedContentSchema = z
  .object({
    eventId: id,
    seq: z.number().int().positive(),
    statementId: id,
    content: classroomBoardPublicContentSchema,
    reviewerUid: learnerUidSchema,
    sceneId: id,
  })
  .strict();
export type CollabBoardReviewedContentDto = z.infer<typeof boardReviewedContentSchema>;

/**
 * 当前场景的公共白板动作历史（协议 3 起，协议 4 扩展内容动作）。
 *
 * `applied` 是**生效位**：撤销只把某条动作标记为不生效，不删除它；重放再置回。
 * 生效白板由基线按 `seq` 顺序重放所有生效动作得到。`write` 追加内容，
 * `erase` 按 `targetEventId` 移除一条已写内容。
 */
const boardActionSchema = z
  .object({
    eventId: id,
    seq: z.number().int().positive(),
    kind: z.enum(['focus', 'laser', 'clear-board', 'write', 'erase']),
    elementId: id.optional(),
    statementId: id.optional(),
    content: classroomBoardPublicContentSchema.optional(),
    reviewEventId: id.optional(),
    targetEventId: id.optional(),
    applied: z.boolean(),
  })
  .strict()
  .superRefine((action, ctx) => {
    const expect = (present: boolean, field: string): void => {
      if (!present)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} missing for ${action.kind}`,
        });
    };
    const forbid = (present: boolean, field: string): void => {
      if (present)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} not allowed for ${action.kind}`,
        });
    };
    const hasElement = action.elementId !== undefined;
    const hasContent = action.content !== undefined;
    const hasStatement = action.statementId !== undefined;
    const hasReviewEvent = action.reviewEventId !== undefined;
    const hasTarget = action.targetEventId !== undefined;
    switch (action.kind) {
      case 'focus':
      case 'laser':
        expect(hasElement, 'elementId');
        forbid(hasContent, 'content');
        forbid(hasStatement, 'statementId');
        forbid(hasTarget, 'targetEventId');
        forbid(hasReviewEvent, 'reviewEventId');
        break;
      case 'clear-board':
        forbid(hasElement, 'elementId');
        forbid(hasContent, 'content');
        forbid(hasStatement, 'statementId');
        forbid(hasTarget, 'targetEventId');
        forbid(hasReviewEvent, 'reviewEventId');
        break;
      case 'write':
        expect(hasContent, 'content');
        expect(hasStatement, 'statementId');
        forbid(hasElement, 'elementId');
        forbid(hasTarget, 'targetEventId');
        break;
      case 'erase':
        expect(hasTarget, 'targetEventId');
        forbid(hasElement, 'elementId');
        forbid(hasContent, 'content');
        forbid(hasStatement, 'statementId');
        forbid(hasReviewEvent, 'reviewEventId');
        break;
    }
  });

const boardHistorySchema = z
  .object({
    baseline: z.object({ focusElementId: id.nullable(), laserElementId: id.nullable() }).strict(),
    actions: z
      .array(boardActionSchema)
      .max(200)
      .superRefine((actions, ctx) => {
        const eventIds = new Set<string>();
        const seqs = new Set<number>();
        let previousSeq = 0;
        actions.forEach((action, index) => {
          if (eventIds.has(action.eventId))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'eventId'],
              message: 'duplicate eventId',
            });
          if (seqs.has(action.seq))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'seq'],
              message: 'duplicate seq',
            });
          if (action.seq <= previousSeq)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'seq'],
              message: 'actions must be ordered by seq',
            });
          eventIds.add(action.eventId);
          seqs.add(action.seq);
          previousSeq = action.seq;
        });
      }),
  })
  .strict();

export const collabTeachingStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    roomId: id,
    sceneId: id,
    board: z
      .object({
        focusElementId: id.nullable(),
        laserElementId: id.nullable(),
        /** 已写入公共白板的内容；历史重放得到，随场景切换清空。可选以兼容旧状态。 */
        contents: z.array(boardContentSchema).max(200).optional(),
        /** Explicit human review receipts. Optional only for legacy persisted states. */
        reviewedContents: z.array(boardReviewedContentSchema).max(200).optional(),
        /** Optional for backwards compatibility with already persisted v1 states. */
        history: boardHistorySchema.optional(),
      })
      .strict()
      .superRefine((board, ctx) => {
        const eventIds = new Set<string>();
        const seqs = new Set<number>();
        let previousSeq = 0;
        (board.reviewedContents ?? []).forEach((receipt, index) => {
          if (eventIds.has(receipt.eventId))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['reviewedContents', index, 'eventId'],
              message: 'duplicate review eventId',
            });
          if (seqs.has(receipt.seq) || receipt.seq <= previousSeq)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['reviewedContents', index, 'seq'],
              message: 'review receipts must be ordered by unique seq',
            });
          eventIds.add(receipt.eventId);
          seqs.add(receipt.seq);
          previousSeq = receipt.seq;
        });
      }),
    waiting: z
      .object({
        waitEventId: id,
        sceneId: id,
        targetUid: learnerUidSchema,
        acknowledged: z.boolean(),
      })
      .strict()
      .nullable(),
    /** Bounded public transcript. At the limit, further speech is explicitly refused. */
    outputs: z
      .array(
        z
          .object({
            eventId: id,
            seq: z.number().int().positive(),
            sceneId: id,
            statementId: id,
            body: collabText(2000),
            conditions: z.string().max(2000),
            source: z.literal('reviewed_statement'),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type CollabTeachingStateDto = z.infer<typeof collabTeachingStateSchema>;

export const collabTeachingViewSchema = z
  .object({
    state: collabTeachingStateSchema,
    roomRevision: z.number().int().positive(),
    tailSeq: z.number().int().nonnegative(),
  })
  .strict();
export type CollabTeachingViewDto = z.infer<typeof collabTeachingViewSchema>;

export const collabTeachingResultSchema = z
  .object({
    state: collabTeachingStateSchema,
    roomRevision: z.number().int().positive(),
    event: collabEventSchema,
    deduplicated: z.boolean(),
  })
  .strict();
export type CollabTeachingResultDto = z.infer<typeof collabTeachingResultSchema>;
