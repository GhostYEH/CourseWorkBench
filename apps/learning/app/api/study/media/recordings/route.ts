import { createHash } from 'node:crypto';
import { projectScopeSchema, StudyError } from '@sew/study-contracts';
import { ok, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { readBoundedBody } from '../../../../../lib/server/bounded-body';
import { MAX_PROJECT_ASSET_BYTES } from '../../../../../lib/server/classroom-assets';
import { RECORDING_MAX_BYTES, recordingWavSeconds } from '../../../../../lib/recording-wav';

export const dynamic = 'force-dynamic';

/** Saving a local recording neither dispatches a provider nor grants transcription consent. */
export const POST = route(async (request: Request) => {
  const url = new URL(request.url);
  const rawGeneration = url.searchParams.get('generation');
  if (!rawGeneration || !/^\d+$/.test(rawGeneration)) throw new StudyError('INVALID_ARGUMENT');
  const parsed = projectScopeSchema.safeParse({
    projectId: url.searchParams.get('projectId'),
    generation: Number(rawGeneration),
  });
  const requestId = request.headers.get('x-recording-request-id');
  if (
    !parsed.success ||
    !requestId ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(requestId) ||
    request.headers.has('content-encoding') ||
    request.headers.get('content-type') !== 'audio/wav'
  )
    throw new StudyError('INVALID_ARGUMENT', { reason: 'recording_request_invalid' });
  const session = assertScope(parsed.data);
  const bytes = await readBoundedBody(
    request,
    RECORDING_MAX_BYTES,
    () => new StudyError('INVALID_ARGUMENT', { reason: 'recording_body_invalid' }),
  );
  if (request.signal.aborted) throw new StudyError('RUN_TERMINATED');
  const current = assertScope(parsed.data);
  if (current.store !== session.store) throw new StudyError('PROJECT_GENERATION_STALE');
  let seconds: number;
  try {
    seconds = recordingWavSeconds(bytes);
  } catch {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'recording_wav_invalid' });
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const assetId = `recording_${createHash('sha256').update(`${session.projectId}:${requestId}`).digest('hex').slice(0, 32)}`;
  const result = current.store.transaction(() => {
    const previous = current.store.getClassroomAsset(session.projectId, assetId);
    if (previous) {
      if (
        previous.sha256 !== sha256 ||
        previous.mediaType !== 'audio/wav' ||
        previous.metadata['recordingRequestId'] !== requestId
      )
        throw new StudyError('VERSION_CONFLICT', { reason: 'recording_request_reused' });
      return previous;
    }
    if (
      current.store.classroomAssetBytes(session.projectId) + bytes.length >
      MAX_PROJECT_ASSET_BYTES
    )
      throw new StudyError('BUDGET_EXCEEDED', { reason: 'recording_storage_quota' });
    return current.store.putClassroomAsset(
      session.projectId,
      assetId,
      'audio/wav',
      { recordingRequestId: requestId, durationSeconds: seconds, origin: 'user_recorded' },
      bytes,
      'formal',
    );
  });
  return ok(
    {
      assetId: result.assetId,
      mime: result.mediaType,
      seconds,
      sha256: result.sha256,
      byteLength: result.bytes.length,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
});
