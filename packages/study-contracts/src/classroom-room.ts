import { z } from 'zod';
import { evidenceRefSchema, projectScopeSchema } from './api';
import { learnerUidSchema } from './learner-profile';

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Shared text never accepts an operating-system resource path. Assets have an explicit manifest instead.
const publicText = (max: number) => z.string().max(max).refine(
  value => !/(?:[a-z]:[\\/]|file:\/\/|\\\\[^\\]|(?:^|[\s"'(=])\/(?:Users|home|tmp|var|etc|mnt|private|opt)\/)/i.test(value),
  '共享内容不能含本地文件路径',
);

export const classroomRoomCourseSchema = z.object({
  lessonId: id, lessonVersion: z.number().int().positive(), title: publicText(120),
  stageId: id, dslVersion: z.string().min(1).max(40), documentDigest: digest, bundleDigest: digest,
}).strict();

export const classroomSharedSceneSchema = z.discriminatedUnion('type', [
  z.object({
    sceneId: id, type: z.literal('slide'), title: publicText(200), order: z.number().int().nonnegative(),
    elements: z.array(z.object({
      elementId: id, type: z.literal('text'), left: z.number().finite(), top: z.number().finite(),
      width: z.number().positive().finite(), height: z.number().positive().finite(), rotate: z.number().finite(),
      text: publicText(100_000),
    }).strict()).min(1).max(200),
  }).strict(),
  z.object({
    sceneId: id, type: z.literal('quiz'), title: publicText(200), order: z.number().int().nonnegative(),
    questions: z.array(z.object({
      questionId: id, type: z.enum(['single', 'multiple', 'short_answer']), stem: publicText(20_000),
      options: z.array(z.object({ value: id, label: publicText(2000) }).strict()).max(40),
    }).strict()).min(1).max(40),
  }).strict(),
  /**
   * 已审核正式互动的公共投影。
   *
   * 只带「对方操作所必需」的公开定义：参数实验的范围与步长、概念关系的节点与关系名。
   * 刻意**不含**关系正确目标（`to`）、评分规则、参考答案与他人私人观察——
   * 公共投影是给另一位成员看的课堂材料，不是把整份私人记录复制过去。
   * 公开定义变化（含 `predictionRequired`）会改变快照摘要，从而让共享版本可核对。
   */
  z.object({
    sceneId: id, type: z.literal('interactive'), title: publicText(200), order: z.number().int().nonnegative(),
    interaction: z.discriminatedUnion('kind', [
      z.object({
        interactionId: id, kind: z.literal('parameter'), title: publicText(120),
        statementIds: z.array(id).min(1).max(24), formula: z.literal('linear'),
        min: z.number().finite(), max: z.number().finite(), step: z.number().positive(), intercept: z.number().finite(),
        predictionRequired: z.boolean(),
      }).strict(),
      z.object({
        interactionId: id, kind: z.literal('concept_relation'), title: publicText(120),
        statementIds: z.array(id).min(1).max(24),
        nodes: z.array(z.object({ id, label: publicText(200) }).strict()).min(2).max(24),
        edges: z.array(z.object({ id, from: id, label: publicText(200) }).strict()).min(1).max(48),
      }).strict(),
    ]),
  }).strict(),
]);

export const classroomSharedAssetSchema = z.object({
  assetId: id, mediaType: z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/), sha256: digest,
  byteLength: z.number().int().nonnegative().max(128 * 1024 * 1024), revision: z.number().int().positive(),
  bindings: z.array(z.object({ sceneId: id, slot: id }).strict()).min(1).max(200),
}).strict();

/** A portable public projection, not an arbitrary OpenMAIC document or a copy of the project. */
export const classroomSharedCourseSchema = z.object({
  snapshotVersion: z.literal(1), course: classroomRoomCourseSchema,
  scenes: z.array(classroomSharedSceneSchema).min(1).max(200),
  evidence: z.object({
    planVersion: z.number().int().positive(),
    knowledgeVersions: z.array(z.object({ knowledgeId: id, revision: z.number().int().nonnegative() }).strict()).min(1).max(1000),
    statements: z.array(z.object({
      statementId: id, knowledgeId: id, text: publicText(2000), conditions: publicText(2000),
      evidence: z.array(evidenceRefSchema).min(1).max(100),
    }).strict()).max(1000),
    segments: z.array(z.object({
      materialId: id, revision: z.number().int().positive(), segmentId: id, fingerprint: digest, text: publicText(200_000),
    }).strict()).min(1).max(1000),
  }).strict(),
  sceneSources: z.array(z.object({
    sceneId: id, knowledgeIds: z.array(id).min(1).max(1000), questionId: id.nullable(),
  }).strict()).min(1).max(200),
  assets: z.array(classroomSharedAssetSchema).max(1000),
}).strict();
export type ClassroomSharedCourseDto = z.infer<typeof classroomSharedCourseSchema>;

export const classroomRoomMemberSchema = z.object({
  uid: learnerUidSchema, role: z.enum(['owner', 'participant']),
  identityAuthority: z.enum(['local_only', 'online_authenticated']),
  status: z.enum(['joined', 'left']), canControl: z.boolean(),
}).strict();
export const classroomRoomSchema = z.object({
  schemaVersion: z.literal(1), roomId: id, mode: z.literal('local_single'), ownerUid: learnerUidSchema,
  status: z.enum(['ready', 'active', 'ended']), revision: z.number().int().positive(), runGeneration: z.number().int().nonnegative(),
  currentSceneId: id, snapshotDigest: digest, course: classroomRoomCourseSchema,
  members: z.array(classroomRoomMemberSchema).min(1).max(2), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type ClassroomRoomDto = z.infer<typeof classroomRoomSchema>;

/** Online invitation lifecycle contract. Local rooms deliberately have no invitation mutation endpoint. */
export const classroomInvitationSchema = z.object({
  invitationId: id, roomId: id, inviterUid: learnerUidSchema, inviteeUid: learnerUidSchema,
  lessonId: id, lessonVersion: z.number().int().positive(), snapshotDigest: digest,
  status: z.enum(['pending', 'accepted', 'rejected', 'revoked', 'expired']),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type ClassroomInvitationDto = z.infer<typeof classroomInvitationSchema>;

export const classroomTeacherLeaseSchema = z.object({
  roomId: id, leaseId: id, holderUid: learnerUidSchema, executorId: id,
  runGeneration: z.number().int().positive(), expiresAt: z.string().datetime(),
}).strict();
export type ClassroomTeacherLeaseDto = z.infer<typeof classroomTeacherLeaseSchema>;

export const classroomRoomCreateSchema = z.object({
  scope: projectScopeSchema, lessonId: id, lessonVersion: z.number().int().positive(), requestId: id,
}).strict();
export const classroomRoomCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('scene'), scope: projectScopeSchema, roomId: id, expectedRevision: z.number().int().positive(), sceneId: id, requestId: id }).strict(),
  z.object({ action: z.literal('close'), scope: projectScopeSchema, roomId: id, expectedRevision: z.number().int().positive(), requestId: id }).strict(),
]);
