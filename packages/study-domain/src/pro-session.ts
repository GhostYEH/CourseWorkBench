import { StudyError } from '@sew/study-contracts';
import {
  proSessionRecordSchema,
  type ProEventDto,
  type ProMessageDto,
  type ProAssistantTurn,
  type ProSkillDto,
  type ProSessionRecordDto,
  type ProTaskDto,
  type ProToolCallDto,
} from '../../study-contracts/src/pro-session';

const normalize = (record: ProSessionRecordDto): ProSessionRecordDto =>
  proSessionRecordSchema.parse(record);

const withRevision = (
  record: ProSessionRecordDto,
  values: Partial<ProSessionRecordDto>,
): ProSessionRecordDto =>
  normalize({
    ...record,
    ...values,
    revision: record.revision + 1,
    updatedAt: new Date().toISOString(),
  });

const nextEvent = (
  record: ProSessionRecordDto,
  input: Omit<ProEventDto, 'sequence'>,
): ProEventDto => ({ ...input, sequence: record.events.length + 1 });

export const createProSession = (input: {
  sessionId: string;
  projectId: string;
  learnerUid: string;
  requestId: string;
  intentDigest: string;
  title: string;
  now: string;
  skills?: ProSkillDto[];
}): ProSessionRecordDto =>
  normalize({
    sessionId: input.sessionId,
    projectId: input.projectId,
    learnerUid: input.learnerUid,
    requestId: input.requestId,
    intentDigest: input.intentDigest,
    title: input.title,
    revision: 0,
    status: 'idle',
    latestTaskId: null,
    createdAt: input.now,
    updatedAt: input.now,
    messages: [],
    events: [
      {
        sequence: 1,
        eventId: `${input.sessionId}:event:1`,
        type: 'session_created',
        taskId: null,
        requestId: input.requestId,
        intentDigest: input.intentDigest,
        message: 'Pro 会话已创建。',
        createdAt: input.now,
      },
    ],
    tasks: [],
    toolCalls: [],
    skills: input.skills ?? [],
  });

export const replayedProRequest = (
  record: ProSessionRecordDto,
  requestId: string,
  intentDigest: string,
): boolean => {
  const receipts = record.events.filter((event) => event.requestId === requestId);
  if (receipts.length === 0) return false;
  if (receipts.some((event) => event.intentDigest !== intentDigest)) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_request_nonce_reused' });
  }
  return true;
};

export const assertProSessionOwner = (
  record: ProSessionRecordDto,
  scope: { projectId: string; learnerUid: string },
): void => {
  if (record.projectId !== scope.projectId || record.learnerUid !== scope.learnerUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'pro_session_owner_mismatch' });
  }
};

export const appendProMessage = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  input: {
    messageId: string;
    requestId: string;
    intentDigest: string;
    role: ProMessageDto['role'];
    content: string;
    toolName?: string | null;
    toolCallId?: string | null;
    eventType: ProEventDto['type'];
    now: string;
  },
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'pro_session_revision_changed',
      expectedRevision,
      actualRevision: record.revision,
    });
  }
  const message: ProMessageDto = {
    messageId: input.messageId,
    sequence: record.messages.length + 1,
    role: input.role,
    content: input.content,
    toolName: input.toolName ?? null,
    toolCallId: input.toolCallId ?? null,
    createdAt: input.now,
  };
  const event = nextEvent(record, {
    eventId: `${input.messageId}:event`,
    type: input.eventType,
    taskId: null,
    requestId: input.requestId,
    intentDigest: input.intentDigest,
    message: input.role === 'user' ? '本人消息已记录。' : '助手消息已记录。',
    createdAt: input.now,
  });
  return withRevision(record, {
    messages: [...record.messages, message],
    events: [...record.events, event],
  });
};

export const startProConversationTurn = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  message: ProMessageDto,
  task: ProTaskDto,
  requestId: string,
  intentDigest: string,
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  if (message.role !== 'user' || task.status !== 'running' || task.sessionId !== record.sessionId) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'pro_turn_identity_invalid' });
  }
  if (record.tasks.some((item) => item.taskId === task.taskId))
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_task_identity_conflict' });
  const userMessage = { ...message, sequence: record.messages.length + 1 };
  const userEvent = nextEvent(record, {
    eventId: `${requestId}:user`,
    type: 'user_message',
    taskId: task.taskId,
    requestId,
    intentDigest,
    message: '本人消息已记录。',
    createdAt: message.createdAt,
  });
  return withRevision(record, {
    latestTaskId: task.taskId,
    status: 'running',
    messages: [...record.messages, userMessage],
    events: [...record.events, userEvent],
    tasks: [...record.tasks, task],
  });
};

export const finishProConversationTurn = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  input: {
    taskId: string;
    message: ProMessageDto;
    turn: ProAssistantTurn;
    toolCall?: ProToolCallDto;
    toolTask?: ProTaskDto;
    requestId: string;
    intentDigest: string;
    now: string;
    taskStatus?: 'completed' | 'failed' | 'cancelled' | 'unknown';
  },
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  const runningTask = record.tasks.find((task) => task.taskId === input.taskId);
  if (!runningTask || runningTask.status !== 'running')
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_conversation_task_not_running' });
  if (input.turn.kind === 'tool_request') {
    if (
      !input.toolCall ||
      !input.toolTask ||
      input.toolCall.status !== 'proposed' ||
      input.toolTask.status !== 'waiting_review'
    ) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'pro_tool_proposal_incomplete' });
    }
    if (
      input.toolTask.sessionId !== record.sessionId ||
      input.toolCall.taskId !== input.toolTask.taskId
    ) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'pro_tool_proposal_identity_mismatch' });
    }
  } else if (input.toolCall || input.toolTask) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'pro_unrequested_tool_payload' });
  }
  const assistantMessage: ProMessageDto = {
    ...input.message,
    sequence: record.messages.length + 1,
    role: 'assistant',
    toolName: null,
    toolCallId: null,
  };
  const assistantEvent = nextEvent(record, {
    eventId: `${input.requestId}:assistant`,
    type: 'assistant_message',
    taskId: input.taskId,
    requestId: input.requestId,
    intentDigest: input.intentDigest,
    message: 'Pro 助手回复已记录。',
    createdAt: input.now,
  });
  const taskStatus = input.taskStatus ?? 'completed';
  const settledRunEvent = nextEvent(
    { ...record, events: [...record.events, assistantEvent] },
    {
      eventId: `${input.taskId}:${input.requestId}:settled`,
      type: taskStatus === 'unknown' ? 'task_unknown' : 'task_settled',
      taskId: input.taskId,
      requestId: input.requestId,
      intentDigest: input.intentDigest,
      message: '对话模型调用已结束。',
      createdAt: input.now,
    },
  );
  const updatedRunTask = { ...runningTask, status: taskStatus, updatedAt: input.now };
  const nextTasks = record.tasks.map((task) =>
    task.taskId === input.taskId ? updatedRunTask : task,
  );
  const nextCalls = [...record.toolCalls];
  const nextEvents = [...record.events, assistantEvent, settledRunEvent];
  let status: ProSessionRecordDto['status'] = taskStatus === 'unknown' ? 'unknown' : 'idle';
  let latestTaskId = input.taskId;
  if (input.turn.kind === 'tool_request' && input.toolCall && input.toolTask) {
    if (
      record.tasks.some((task) => task.taskId === input.toolTask!.taskId) ||
      record.toolCalls.some((call) => call.toolCallId === input.toolCall!.toolCallId)
    ) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'pro_tool_call_duplicate' });
    }
    nextTasks.push(input.toolTask);
    nextCalls.push(input.toolCall);
    nextEvents.push(
      nextEvent(
        { ...record, events: nextEvents },
        {
          eventId: `${input.toolCall.toolCallId}:proposed`,
          type: 'tool_requested',
          taskId: input.toolTask.taskId,
          requestId: input.requestId,
          intentDigest: input.intentDigest,
          message: '助手提出工具请求，等待本人确认。',
          createdAt: input.now,
        },
      ),
    );
    status = 'waiting_review';
    latestTaskId = input.toolTask.taskId;
  }
  return withRevision(record, {
    status,
    latestTaskId,
    messages: [...record.messages, assistantMessage],
    events: nextEvents,
    tasks: nextTasks,
    toolCalls: nextCalls,
  });
};

export const setProSkillEnabled = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  skillId: string,
  enabled: boolean,
  requestId: string,
  intentDigest: string,
  now: string,
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  const skill = record.skills.find((item) => item.skillId === skillId);
  if (!skill) throw new StudyError('NOT_FOUND', { skillId });
  const updated = { ...skill, enabled };
  const event = nextEvent(record, {
    eventId: `${skillId}:${requestId}`,
    type: 'skill_configured',
    taskId: null,
    requestId,
    intentDigest,
    message: `技能 ${skillId} 已${enabled ? '启用' : '停用'}。`,
    createdAt: now,
  });
  return withRevision(record, {
    skills: record.skills.map((item) => (item.skillId === skillId ? updated : item)),
    events: [...record.events, event],
  });
};

export const addProTask = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  task: ProTaskDto,
  requestId: string,
  now: string,
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  if (
    task.sessionId !== record.sessionId ||
    record.tasks.some((item) => item.taskId === task.taskId)
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_task_identity_conflict' });
  }
  return withRevision(record, {
    intentDigest: task.intentDigest,
    latestTaskId: task.taskId,
    status: task.status === 'waiting_review' ? 'waiting_review' : 'running',
    tasks: [...record.tasks, task],
    events: [
      ...record.events,
      nextEvent(record, {
        eventId: `${task.taskId}:created`,
        type: 'task_claimed',
        taskId: task.taskId,
        requestId,
        intentDigest: task.intentDigest,
        message: 'Pro 后台任务已建立。',
        createdAt: now,
      }),
    ],
  });
};

export const requestProControl = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  taskId: string,
  action: 'pause' | 'resume' | 'cancel' | 'takeover',
  requestId: string,
  intentDigest: string,
  now: string,
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  const task = record.tasks.find((item) => item.taskId === taskId);
  if (!task) throw new StudyError('NOT_FOUND', { taskId });
  if (action === 'resume' && !['paused', 'failed'].includes(task.status)) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_task_not_resumable' });
  }
  if (action === 'takeover' && task.status !== 'unknown') {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'pro_task_takeover_requires_unknown_dispatch',
    });
  }
  const status: ProTaskDto['status'] =
    action === 'cancel'
      ? 'cancel_requested'
      : action === 'pause'
        ? 'paused'
        : action === 'resume'
          ? 'queued'
          : action === 'takeover'
            ? 'unknown'
            : task.status;
  const nextTask: ProTaskDto = {
    ...task,
    status,
    cancelRequested: action === 'cancel',
    interventionRequested: action === 'pause' || action === 'takeover',
    updatedAt: now,
  };
  const eventType: ProEventDto['type'] =
    action === 'cancel'
      ? 'cancel_requested'
      : action === 'pause' || action === 'takeover'
        ? 'intervention_requested'
        : 'task_claimed';
  return withRevision(record, {
    tasks: record.tasks.map((item) => (item.taskId === taskId ? nextTask : item)),
    status: status === 'paused' ? 'paused' : status === 'unknown' ? 'unknown' : 'running',
    events: [
      ...record.events,
      nextEvent(record, {
        eventId: `${taskId}:${requestId}`,
        type: eventType,
        taskId,
        requestId,
        intentDigest,
        message:
          action === 'cancel'
            ? '已请求取消任务。'
            : action === 'pause'
              ? '已请求暂停任务。'
              : '已请求继续或接管任务。',
        createdAt: now,
      }),
    ],
  });
};

export const settleProTask = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  taskId: string,
  status: Extract<
    ProTaskDto['status'],
    'waiting_review' | 'cancelled' | 'failed' | 'unknown' | 'completed'
  >,
  requestId: string,
  intentDigest: string,
  now: string,
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  const task = record.tasks.find((item) => item.taskId === taskId);
  if (!task) throw new StudyError('NOT_FOUND', { taskId });
  const nextTask: ProTaskDto = {
    ...task,
    status,
    cancelRequested: false,
    interventionRequested: false,
    updatedAt: now,
  };
  const sessionStatus: ProSessionRecordDto['status'] =
    status === 'waiting_review'
      ? 'waiting_review'
      : status === 'unknown'
        ? 'unknown'
        : status === 'completed' || status === 'cancelled' || status === 'failed'
          ? 'idle'
          : record.status;
  return withRevision(record, {
    status: sessionStatus,
    tasks: record.tasks.map((item) => (item.taskId === taskId ? nextTask : item)),
    events: [
      ...record.events,
      nextEvent(record, {
        eventId: `${taskId}:${requestId}:settled`,
        type: status === 'unknown' ? 'task_unknown' : 'task_settled',
        taskId,
        requestId,
        intentDigest,
        message: `任务状态已记录为 ${status}。`,
        createdAt: now,
      }),
    ],
  });
};

export const addProToolCall = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  call: ProToolCallDto,
  task: ProTaskDto,
  requestId: string,
  now: string,
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  if (record.toolCalls.some((item) => item.toolCallId === call.toolCallId)) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_tool_call_duplicate' });
  }
  const withTask = addProTask(record, expectedRevision, task, requestId, now);
  return normalize({
    ...withTask,
    revision: record.revision + 1,
    toolCalls: [...withTask.toolCalls, call],
    events: [
      ...withTask.events,
      nextEvent(withTask, {
        eventId: `${call.toolCallId}:proposed`,
        type: 'tool_requested',
        taskId: task.taskId,
        requestId,
        intentDigest: call.intentDigest,
        message: '助手提出工具请求，等待本人确认。',
        createdAt: now,
      }),
    ],
  });
};

export const setProToolCallStatus = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  toolCallId: string,
  status: ProToolCallDto['status'],
  requestId: string,
  result: string | null,
  now: string,
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  const call = record.toolCalls.find((item) => item.toolCallId === toolCallId);
  if (!call) throw new StudyError('NOT_FOUND', { toolCallId });
  if (status === 'running' && call.status !== 'approved') {
    throw new StudyError('ROLE_PERMISSION_DENIED', {
      reason: 'pro_tool_requires_explicit_approval',
    });
  }
  if (['completed', 'failed', 'unknown'].includes(call.status)) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_tool_call_already_settled' });
  }
  const nextCall = { ...call, status, result, updatedAt: now };
  return withRevision(record, {
    toolCalls: record.toolCalls.map((item) => (item.toolCallId === toolCallId ? nextCall : item)),
    events: [
      ...record.events,
      nextEvent(record, {
        eventId: `${toolCallId}:${requestId}`,
        type:
          status === 'running'
            ? 'tool_started'
            : status === 'completed'
              ? 'tool_result'
              : 'tool_failed',
        taskId: call.taskId,
        requestId,
        intentDigest: call.intentDigest,
        message:
          status === 'running' ? '本人已确认，开始执行受控工具。' : `工具状态已记录为 ${status}。`,
        createdAt: now,
      }),
    ],
  });
};

export const finishProToolExecution = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  input: {
    toolCallId: string;
    requestId: string;
    status: 'waiting_review' | 'completed' | 'failed' | 'unknown';
    result: string;
    candidateTaskId: string | null;
    now: string;
  },
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  const call = record.toolCalls.find((item) => item.toolCallId === input.toolCallId);
  const task = call ? record.tasks.find((item) => item.taskId === call.taskId) : null;
  if (!call || !task) throw new StudyError('NOT_FOUND', { toolCallId: input.toolCallId });
  if (call.status !== 'running' || task.status !== 'running')
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_tool_execution_not_running' });
  const callStatus: ProToolCallDto['status'] =
    input.status === 'unknown' ? 'unknown' : input.status === 'failed' ? 'failed' : 'completed';
  const taskStatus: ProTaskDto['status'] = input.status;
  const toolMessage: ProMessageDto = {
    messageId: `${input.toolCallId}:result`,
    sequence: record.messages.length + 1,
    role: 'tool',
    content: input.result.slice(0, 20_000),
    toolName: call.tool,
    toolCallId: call.toolCallId,
    createdAt: input.now,
  };
  const event = nextEvent(record, {
    eventId: `${input.toolCallId}:${input.requestId}:result`,
    type:
      input.status === 'unknown'
        ? 'task_unknown'
        : input.status === 'failed'
          ? 'tool_failed'
          : 'tool_result',
    taskId: task.taskId,
    requestId: input.requestId,
    intentDigest: call.intentDigest,
    message:
      input.status === 'unknown'
        ? '工具执行结果未知，必须先核对已有结果；系统不会自动重派。'
        : input.status === 'failed'
          ? '受控工具执行失败。'
          : input.status === 'waiting_review'
            ? '工具已生成待审核候选，等待本人审核。'
            : '受控只读工具已完成。',
    createdAt: input.now,
  });
  const updatedCall = {
    ...call,
    status: callStatus,
    result: input.result.slice(0, 20_000),
    updatedAt: input.now,
  };
  const updatedTask: ProTaskDto = {
    ...task,
    status: taskStatus,
    candidateTaskId: input.candidateTaskId,
    cancelRequested: false,
    interventionRequested: false,
    errorCode: input.status === 'failed' ? 'TOOL_FAILED' : null,
    updatedAt: input.now,
  };
  return withRevision(record, {
    status:
      input.status === 'waiting_review'
        ? 'waiting_review'
        : input.status === 'unknown'
          ? 'unknown'
          : 'idle',
    tasks: record.tasks.map((item) => (item.taskId === task.taskId ? updatedTask : item)),
    toolCalls: record.toolCalls.map((item) =>
      item.toolCallId === call.toolCallId ? updatedCall : item,
    ),
    messages: [...record.messages, toolMessage],
    events: [...record.events, event],
  });
};

export const reviewProCandidate = (
  record: ProSessionRecordDto,
  expectedRevision: number,
  input: {
    taskId: string;
    candidateTaskId: string;
    decision: 'approved' | 'rejected';
    requestId: string;
    intentDigest: string;
    now: string;
  },
): ProSessionRecordDto => {
  if (record.revision !== expectedRevision)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_session_revision_changed' });
  const task = record.tasks.find((item) => item.taskId === input.taskId);
  if (!task || task.status !== 'waiting_review' || task.candidateTaskId !== input.candidateTaskId)
    throw new StudyError('VERSION_CONFLICT', { reason: 'pro_candidate_review_not_pending' });
  const event = nextEvent(record, {
    eventId: `${input.taskId}:${input.requestId}:review`,
    type: 'candidate_reviewed',
    taskId: input.taskId,
    requestId: input.requestId,
    intentDigest: input.intentDigest,
    message:
      input.decision === 'approved'
        ? '本人已审核候选并批准应用。'
        : '本人已拒绝候选，原有课程数据未被写入。',
    createdAt: input.now,
  });
  return withRevision(record, {
    status: 'idle',
    tasks: record.tasks.map((item) =>
      item.taskId === task.taskId ? { ...item, status: 'completed', updatedAt: input.now } : item,
    ),
    events: [...record.events, event],
  });
};
