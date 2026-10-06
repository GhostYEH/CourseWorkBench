import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  StudyError,
  collabOnlineCommandSchema,
  type CollabOnlineCommand,
} from '@sew/study-contracts';
import { decodeJson } from '@sew/study-storage';
import { resolveUserDataDir } from './global-preferences';
import type { Session } from './service';

const schema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    uid: z.string(),
    commands: z.array(collabOnlineCommandSchema).max(200),
  })
  .strict();

const pathFor = (session: Session): string =>
  join(
    resolveUserDataDir(),
    'collab-command-outbox',
    `${createHash('sha256')
      .update(JSON.stringify([session.projectId, session.learnerUid]))
      .digest('hex')}.json`,
  );

const read = (session: Session): CollabOnlineCommand[] => {
  let raw: string;
  try {
    raw = readFileSync(pathFor(session), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw new StudyError('INTERNAL', { reason: 'collab_outbox_unreadable' });
  }
  const parsed = decodeJson(raw, schema, null, 'collab-command-outbox');
  if (
    !parsed.ok ||
    !parsed.value ||
    parsed.value.projectId !== session.projectId ||
    parsed.value.uid !== session.learnerUid
  ) {
    throw new StudyError('INTERNAL', { reason: 'collab_outbox_invalid' });
  }
  return parsed.value.commands;
};

const write = (session: Session, commands: CollabOnlineCommand[]): void => {
  const dir = join(resolveUserDataDir(), 'collab-command-outbox');
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `${randomUUID()}.tmp`);
  const value = schema.parse({
    version: 1,
    projectId: session.projectId,
    uid: session.learnerUid,
    commands,
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

const intentOf = (command: CollabOnlineCommand): string => {
  const intent: Record<string, unknown> = { ...command };
  delete intent['requestId'];
  if (command.action === 'invite') delete intent['roomId'];
  if (command.action === 'scene') {
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
  const commands = read(session);
  const prior = commands.find((item) => intentOf(item) === intentOf(valid));
  if (prior) return prior;
  if (commands.some((item) => item.requestId === valid.requestId)) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_request_reused' });
  }
  if (commands.length >= 200)
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_outbox_full' });
  write(session, [...commands, valid]);
  return valid;
};

/** Only the renderer's explicit acknowledgement retires an intent; a lost HTTP response leaves it retryable. */
export const confirmOnlineCommand = (session: Session, requestId: string): void => {
  const commands = read(session);
  const remaining = commands.filter((item) => item.requestId !== requestId);
  if (remaining.length !== commands.length) write(session, remaining);
};
