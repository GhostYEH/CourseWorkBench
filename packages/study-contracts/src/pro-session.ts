import { z } from 'zod';
import { projectScopeSchema } from './api';

const id = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime();

export const proSkillSourceSchema = z.enum(['builtin', 'custom']);
export type ProSkillSource = z.infer<typeof proSkillSourceSchema>;

export const proSkillDtoSchema = z
  .object({
    skillId: id,
    title: z.string().trim().min(1).max(120),
    description: z.string().max(500),
    source: proSkillSourceSchema,
    revision: id,
    contentDigest: digest,
    enabled: z.boolean(),
  })
  .strict();
export type ProSkillDto = z.infer<typeof proSkillDtoSchema>;

export const proMessageSchema = z
  .object({
    messageId: id,
    sequence: z.number().int().positive(),
    role: z.enum(['user', 'assistant', 'tool']),
    content: z.string().max(20_000),
    toolName: z.string().max(80).nullable(),
    toolCallId: id.nullable(),
    createdAt: date,
  })
  .strict();
export type ProMessageDto = z.infer<typeof proMessageSchema>;

export const proEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    eventId: id,
    type: z.enum([
      'session_created',
      'user_message',
      'assistant_message',
      'tool_requested',
      'tool_started',
      'tool_result',
      'tool_failed',
      'candidate_reviewed',
      'task_claimed',
      'task_heartbeat',
      'cancel_requested',
      'intervention_requested',
      'task_settled',
      'task_unknown',
      'session_renamed',
      'skill_configured',
    ]),
    taskId: id.nullable(),
    requestId: id.nullable(),
    intentDigest: digest.nullable(),
    message: z.string().max(1000),
    createdAt: date,
  })
  .strict();
export type ProEventDto = z.infer<typeof proEventSchema>;

export const proTaskStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_review',
  'paused',
  'cancel_requested',
  'cancelled',
  'failed',
  'unknown',
  'completed',
]);
export type ProTaskStatus = z.infer<typeof proTaskStatusSchema>;

export const proTaskSchema = z
  .object({
    taskId: id,
    sessionId: id,
    status: proTaskStatusSchema,
    revision: z.number().int().nonnegative(),
    intentDigest: digest,
    bundleId: id.nullable(),
    bundleDigest: digest.nullable(),
    leaseEpoch: z.number().int().nonnegative(),
    leaseExpiresAt: date.nullable(),
    cancelRequested: z.boolean(),
    interventionRequested: z.boolean(),
    candidateTaskId: id.nullable(),
    errorCode: z.string().max(100).nullable(),
    createdAt: date,
    updatedAt: date,
  })
  .strict();
export type ProTaskDto = z.infer<typeof proTaskSchema>;

export const proSessionStatusSchema = z.enum([
  'idle',
  'running',
  'waiting_review',
  'paused',
  'stopped',
  'unknown',
]);
export type ProSessionStatus = z.infer<typeof proSessionStatusSchema>;

export const proSessionSchema = z
  .object({
    sessionId: id,
    projectId: id,
    learnerUid: id,
    requestId: id,
    intentDigest: digest,
    title: z.string().trim().min(1).max(120),
    revision: z.number().int().nonnegative(),
    status: proSessionStatusSchema,
    latestTaskId: id.nullable(),
    createdAt: date,
    updatedAt: date,
  })
  .strict();
export type ProSessionDto = z.infer<typeof proSessionSchema>;

export const proToolNameSchema = z.enum([
  'materials.read',
  'courses.draft',
  'courses.scene-plan.propose',
  'courses.candidate.list',
]);
export type ProToolName = z.infer<typeof proToolNameSchema>;

export const proToolCallStatusSchema = z.enum([
  'proposed',
  'approved',
  'running',
  'completed',
  'rejected',
  'failed',
  'unknown',
]);
export type ProToolCallStatus = z.infer<typeof proToolCallStatusSchema>;

export const proToolCallSchema = z
  .object({
    toolCallId: id,
    taskId: id,
    tool: proToolNameSchema,
    arguments: z.record(z.string(), z.unknown()),
    status: proToolCallStatusSchema,
    intentDigest: digest,
    result: z.string().max(20_000).nullable(),
    createdAt: date,
    updatedAt: date,
  })
  .strict();
export type ProToolCallDto = z.infer<typeof proToolCallSchema>;

export const proSessionRecordSchema = proSessionSchema
  .extend({
    messages: z.array(proMessageSchema).max(10_000),
    events: z.array(proEventSchema).max(20_000),
    tasks: z.array(proTaskSchema).max(200),
    toolCalls: z.array(proToolCallSchema).max(1000),
    skills: z.array(proSkillDtoSchema).max(128),
  })
  .strict()
  .superRefine((record, context) => {
    const checkSequence = (items: readonly { sequence: number }[], path: string): void => {
      items.forEach((item, index) => {
        if (item.sequence !== index + 1) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path, index, 'sequence'],
            message: '序列号必须从 1 开始连续递增',
          });
        }
      });
    };
    checkSequence(record.messages, 'messages');
    checkSequence(record.events, 'events');
    if (
      record.messages.some(
        (message) => message.role === 'tool' && (!message.toolName || !message.toolCallId),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages'],
        message: '工具结果必须绑定工具名与调用编号',
      });
    }
    if (record.messages.some((message) => message.role !== 'tool' && message.toolName !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages'],
        message: '非工具消息不能带工具名',
      });
    }
    if (record.latestTaskId && !record.tasks.some((task) => task.taskId === record.latestTaskId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latestTaskId'],
        message: '最新任务必须存在于当前会话',
      });
    }
    if (
      record.toolCalls.some((call) => !record.tasks.some((task) => task.taskId === call.taskId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolCalls'],
        message: '工具调用必须关联持久任务',
      });
    }
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 4 * 1024 * 1024) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [], message: '会话历史超过4MiB限制' });
    }
  });
export type ProSessionRecordDto = z.infer<typeof proSessionRecordSchema>;

export const proSessionDetailSchema = proSessionRecordSchema;
export type ProSessionDetailDto = z.infer<typeof proSessionDetailSchema>;

export const proCustomSkillRecordSchema = z
  .object({
    skillId: id,
    projectId: id,
    learnerUid: id,
    requestId: id,
    intentDigest: digest,
    revision: z.number().int().positive(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N} _.-]+$/u),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    content: z.string().trim().min(1).max(12_000),
    enabled: z.boolean(),
    createdAt: date,
    updatedAt: date,
  })
  .strict()
  .refine((value) => new TextEncoder().encode(value.content).byteLength <= 12 * 1024, {
    path: ['content'],
    message: '自定义技能正文超过12KiB限制',
  });
export type ProCustomSkillRecordDto = z.infer<typeof proCustomSkillRecordSchema>;

export const proAssistantTurnSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), content: z.string().trim().min(1).max(20_000) }).strict(),
  z
    .object({
      kind: z.literal('tool_request'),
      content: z.string().trim().min(1).max(2000),
      tool: proToolNameSchema,
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export type ProAssistantTurn = z.infer<typeof proAssistantTurnSchema>;

const commonCommand = { scope: projectScopeSchema, requestId: id };
export const proSessionCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...commonCommand,
      action: z.literal('create'),
      title: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      ...commonCommand,
      action: z.enum(['skill-create', 'skill-import']),
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[\p{L}\p{N} _.-]+$/u),
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(500),
      content: z.string().trim().min(1).max(12_000),
    })
    .strict(),
  z
    .object({
      ...commonCommand,
      action: z.literal('skill-toggle'),
      sessionId: id,
      expectedRevision: z.number().int().nonnegative(),
      skillId: id,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...commonCommand,
      action: z.literal('skill-delete'),
      skillId: id,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z.object({ ...commonCommand, action: z.literal('skill-export'), skillId: id }).strict(),
  z.object({ ...commonCommand, action: z.literal('list') }).strict(),
  z.object({ ...commonCommand, action: z.literal('get'), sessionId: id }).strict(),
  z
    .object({
      ...commonCommand,
      action: z.literal('send'),
      sessionId: id,
      expectedRevision: z.number().int().nonnegative(),
      content: z.string().trim().min(1).max(4000),
      bundleId: id,
      bundleDigest: digest,
      skillIds: z.array(id).max(24),
    })
    .strict(),
  z
    .object({
      ...commonCommand,
      action: z.literal('execute-tool'),
      sessionId: id,
      expectedRevision: z.number().int().nonnegative(),
      toolCallId: id,
    })
    .strict(),
  z
    .object({
      ...commonCommand,
      action: z.literal('control'),
      sessionId: id,
      expectedRevision: z.number().int().nonnegative(),
      command: z.enum(['pause', 'resume', 'cancel', 'takeover']),
    })
    .strict(),
  z
    .object({
      ...commonCommand,
      action: z.literal('review'),
      sessionId: id,
      expectedRevision: z.number().int().nonnegative(),
      taskId: id,
      candidateTaskId: id,
      decision: z.enum(['approved', 'rejected']),
      note: z.string().trim().max(1000),
      expectedPlanRevision: z.number().int().nonnegative().optional(),
      override: z.boolean().default(false),
    })
    .strict(),
]);
export type ProSessionCommand = z.infer<typeof proSessionCommandSchema>;

export const proSessionResponseSchema = z
  .object({
    detail: proSessionDetailSchema.nullable(),
    sessions: z.array(proSessionRecordSchema).max(256),
    skills: z.array(proCustomSkillRecordSchema).max(256).optional(),
    skill: proCustomSkillRecordSchema.optional(),
    replayed: z.boolean(),
  })
  .strict();
export type ProSessionResponse = z.infer<typeof proSessionResponseSchema>;
export const proSessionsViewSchema = z
  .object({
    sessions: z.array(proSessionRecordSchema).max(256),
    skills: z.array(proCustomSkillRecordSchema).max(256),
  })
  .strict();
