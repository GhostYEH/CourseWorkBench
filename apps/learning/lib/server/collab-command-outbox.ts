import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  StudyError,
  collabOnlineCommandSchema,
  classroomBoardPublicContentSchema,
  type CollabOnlineCommand,
} from '@sew/study-contracts';
import { decodeJson } from '@sew/study-storage';
import { resolveUserDataDir } from './global-preferences';
import type { Session } from './service';

const envelopeSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    uid: z.string(),
    commands: z.array(z.unknown()).max(200),
  })
  .strict();

/** Strict v4 record shape retained for diagnostics; it is never returned for replay. */
const legacyBoardWriteSchema = z
  .object({
    action: z.literal('teaching'),
    roomId: z.string().min(1).max(200),
    sceneId: z.string().min(1).max(200),
    expectedRevision: z.number().int().positive(),
    expectedSeq: z.number().int().positive(),
    eventId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    operation: z
      .object({
        kind: z.literal('write'),
        statementId: z.string().min(1).max(200),
        content: classroomBoardPublicContentSchema,
      })
      .strict(),
  })
  .strict();
type LegacyBoardWrite = z.infer<typeof legacyBoardWriteSchema>;
type OutboxEntry =
  | { kind: 'current'; command: CollabOnlineCommand }
  | { kind: 'legacy-board-write'; command: LegacyBoardWrite };

export interface LegacyOnlineCommandMetadata {
  count: number;
  requestIds: string[];
  commands: Array<{ requestId: string; roomId: string; sceneId: string; eventId: string }>;
  reason: 'board_write_requires_review';
}

const pathFor = (session: Session): string =>
  join(
    resolveUserDataDir(),
    'collab-command-outbox',
    `${createHash('sha256')
      .update(JSON.stringify([session.projectId, session.learnerUid]))
      .digest('hex')}.json`,
  );

const read = (session: Session): OutboxEntry[] => {
  let raw: string;
  try {
    raw = readFileSync(pathFor(session), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw new StudyError('INTERNAL', { reason: 'collab_outbox_unreadable' });
  }
  const parsed = decodeJson(raw, envelopeSchema, null, 'collab-command-outbox');
  if (
    !parsed.ok ||
    !parsed.value ||
    parsed.value.projectId !== session.projectId ||
    parsed.value.uid !== session.learnerUid
  ) {
    throw new StudyError('INTERNAL', { reason: 'collab_outbox_invalid' });
  }
  const entries: OutboxEntry[] = [];
  for (const command of parsed.value.commands) {
    const current = collabOnlineCommandSchema.safeParse(command);
    if (current.success) {
      entries.push({ kind: 'current', command: current.data });
      continue;
    }
    const legacy = legacyBoardWriteSchema.safeParse(command);
    if (!legacy.success) throw new StudyError('INTERNAL', { reason: 'collab_outbox_invalid' });
    // Keep the validated raw JSON object so later v5 writes do not normalize or replace it.
    entries.push({ kind: 'legacy-board-write', command: command as LegacyBoardWrite });
  }
  return entries;
};

const write = (session: Session, entries: OutboxEntry[]): void => {
  const dir = join(resolveUserDataDir(), 'collab-command-outbox');
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `${randomUUID()}.tmp`);
  const value = envelopeSchema.parse({
    version: 1,
    projectId: session.projectId,
    uid: session.learnerUid,
    commands: entries.map((entry) => entry.command),
  });
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, pathFor(session));
  } finally {
    rmSync(temporary, { force: true });
  }
};

/** Metadata only: legacy write bodies stay private and are never replayed by the v5 client. */
export const readLegacyOnlineCommands = (session: Session): LegacyOnlineCommandMetadata => {
  const legacy = read(session).filter((entry) => entry.kind === 'legacy-board-write');
  return {
    count: legacy.length,
    requestIds: legacy.map((entry) => entry.command.requestId),
    commands: legacy.map(({ command }) => ({
      requestId: command.requestId,
      roomId: command.roomId,
      sceneId: command.sceneId,
      eventId: command.eventId,
    })),
    reason: 'board_write_requires_review',
  };
};

const intentOf = (command: CollabOnlineCommand): string => {
  const intent: Record<string, unknown> = { ...command };
  delete intent['requestId'];
  if (command.action === 'invite') delete intent['roomId'];
  if (
    command.action === 'scene' ||
    command.action === 'teaching' ||
    command.action === 'teaching-ai'
  ) {
    delete intent['eventId'];
    delete intent['expectedSeq'];
    delete intent['expectedRevision'];
  }
  return JSON.stringify(Object.entries(intent).sort(([a], [b]) => a.localeCompare(b)));
};

/** Save before remote IO; the same unacknowledged intent keeps its full payload across changing origins. */
export const prepareOnlineCommand = (
  session: Session,
  command: CollabOnlineCommand,
): CollabOnlineCommand => {
  const valid = collabOnlineCommandSchema.parse(command);
  const entries = read(session);
  const prior = entries.find(
    (entry) => entry.kind === 'current' && intentOf(entry.command) === intentOf(valid),
  );
  if (prior?.kind === 'current') return prior.command;
  if (entries.some((entry) => entry.command.requestId === valid.requestId)) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_request_reused' });
  }
  if (entries.length >= 200)
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_outbox_full' });
  write(session, [...entries, { kind: 'current', command: valid }]);
  return valid;
};

/** Only the renderer's explicit acknowledgement retires an intent; a lost HTTP response leaves it retryable. */
export const confirmOnlineCommand = (session: Session, requestId: string): void => {
  const entries = read(session);
  const remaining = entries.filter((entry) => entry.command.requestId !== requestId);
  if (remaining.length !== entries.length) write(session, remaining);
};
