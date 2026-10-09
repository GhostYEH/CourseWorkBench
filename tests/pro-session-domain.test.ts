import { describe, expect, it } from 'vitest';
import { StudyError } from '@sew/study-contracts';
import {
  appendProMessage,
  assertProSessionOwner,
  createProSession,
  requestProControl,
  settleProTask,
  setProToolCallStatus,
} from '../packages/study-domain/src/pro-session';
import {
  proCustomSkillRecordSchema,
  proSessionRecordSchema,
  type ProTaskDto,
  type ProToolCallDto,
} from '../packages/study-contracts/src/pro-session';

const timestamp = '2026-10-08T12:00:00.000Z';
const digest = 'a'.repeat(64);

const session = () =>
  createProSession({
    sessionId: 'pro_session_1',
    projectId: 'project_1',
    learnerUid: 'learner_1',
    requestId: 'create-1',
    intentDigest: digest,
    title: '一次函数课程',
    now: timestamp,
  });

const task = (status: ProTaskDto['status'] = 'unknown'): ProTaskDto => ({
  taskId: 'pro_task_1',
  sessionId: 'pro_session_1',
  status,
  revision: 0,
  intentDigest: digest,
  bundleId: 'bundle_1',
  bundleDigest: digest,
  leaseEpoch: 1,
  leaseExpiresAt: timestamp,
  cancelRequested: false,
  interventionRequested: false,
  candidateTaskId: null,
  errorCode: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const toolCall = (status: ProToolCallDto['status'] = 'proposed'): ProToolCallDto => ({
  toolCallId: 'tool_call_1',
  taskId: 'pro_task_1',
  tool: 'courses.draft',
  arguments: { bundleId: 'bundle_1' },
  status,
  intentDigest: digest,
  result: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});

describe('Pro session domain', () => {
  it('persists owner-bound messages with consecutive sequences and revision checks', () => {
    const created = session();
    const updated = appendProMessage(created, 0, {
      messageId: 'message_1',
      requestId: 'send-1',
      intentDigest: digest,
      role: 'user',
      content: '请按已审核材料准备课程草案',
      eventType: 'user_message',
      now: timestamp,
    });
    expect(updated.revision).toBe(1);
    expect(updated.messages.map((message) => message.sequence)).toEqual([1]);
    expect(updated.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(() =>
      assertProSessionOwner(updated, { projectId: 'other', learnerUid: 'learner_1' }),
    ).toThrow(StudyError);
    expect(() =>
      appendProMessage(updated, 0, {
        messageId: 'message_2',
        requestId: 'send-2',
        intentDigest: digest,
        role: 'assistant',
        content: '候选草案待审。',
        eventType: 'assistant_message',
        now: timestamp,
      }),
    ).toThrow(StudyError);
  });

  it('requires explicit approval before tool dispatch and refuses terminal replay', () => {
    let value = session();
    value = {
      ...value,
      tasks: [task('queued')],
      toolCalls: [toolCall()],
      latestTaskId: 'pro_task_1',
    };
    expect(() =>
      setProToolCallStatus(value, 0, 'tool_call_1', 'running', 'run-1', null, timestamp),
    ).toThrow(StudyError);
    value = setProToolCallStatus(value, 0, 'tool_call_1', 'approved', 'approve-1', null, timestamp);
    expect(value.revision).toBe(1);
    value = setProToolCallStatus(value, 1, 'tool_call_1', 'running', 'run-2', null, timestamp);
    expect(value.toolCalls[0]?.status).toBe('running');
    value = setProToolCallStatus(
      value,
      2,
      'tool_call_1',
      'completed',
      'done-1',
      '已建立待核课程候选。',
      timestamp,
    );
    expect(() =>
      setProToolCallStatus(value, 3, 'tool_call_1', 'running', 'replay', null, timestamp),
    ).toThrow(StudyError);
  });

  it('requires unknown status for takeover and does not automatically replay a task', () => {
    const record = {
      ...session(),
      tasks: [task('unknown')],
      latestTaskId: 'pro_task_1',
    };
    const taken = requestProControl(
      record,
      0,
      'pro_task_1',
      'takeover',
      'takeover-1',
      digest,
      timestamp,
    );
    expect(taken.tasks[0]?.status).toBe('unknown');
    expect(taken.tasks[0]?.cancelRequested).toBe(false);
    expect(() =>
      requestProControl(
        { ...record, tasks: [task('running')] },
        0,
        'pro_task_1',
        'takeover',
        'takeover-2',
        digest,
        timestamp,
      ),
    ).toThrow(StudyError);
  });

  it('allows explicit cancellation but never treats the request as settled', () => {
    const record = { ...session(), tasks: [task('running')], latestTaskId: 'pro_task_1' };
    const requested = requestProControl(
      record,
      0,
      'pro_task_1',
      'cancel',
      'cancel-1',
      digest,
      timestamp,
    );
    expect(requested.tasks[0]?.status).toBe('cancel_requested');
    expect(requested.tasks[0]?.cancelRequested).toBe(true);
    const settled = settleProTask(
      requested,
      1,
      'pro_task_1',
      'cancelled',
      'cancel-settle-1',
      digest,
      timestamp,
    );
    expect(settled.tasks[0]?.status).toBe('cancelled');
    expect(settled.events.at(-1)?.type).toBe('task_settled');
  });

  it('validates exact event/message sequences, record byte cap and custom-skill content bounds', () => {
    expect(
      proSessionRecordSchema.safeParse({
        ...session(),
        messages: [
          { ...session().events[0], role: 'user', content: 'x', toolName: null, toolCallId: null },
        ],
      }).success,
    ).toBe(false);
    expect(
      proSessionRecordSchema.safeParse({
        ...session(),
        messages: [],
        events: [{ ...session().events[0], sequence: 2 }],
      }).success,
    ).toBe(false);
    expect(
      proSessionRecordSchema.safeParse({ ...session(), title: 'x'.repeat(5 * 1024 * 1024) })
        .success,
    ).toBe(false);
    const custom = {
      skillId: 'custom_skill_1',
      projectId: 'project_1',
      learnerUid: 'learner_1',
      requestId: 'skill-1',
      intentDigest: digest,
      revision: 1,
      name: '../escape',
      title: '不安全名称',
      description: '技能',
      content: '只作为资料',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(proCustomSkillRecordSchema.safeParse(custom).success).toBe(false);
    expect(
      proCustomSkillRecordSchema.safeParse({
        ...custom,
        name: 'safe-skill',
        content: 'x'.repeat(12 * 1024 + 1),
      }).success,
    ).toBe(false);
  });
});
