'use client';

import { apiEnvelopeSchema, apiResponses, type ProjectScope } from '@sew/study-contracts';
import { ApiError, waitForSessionToken } from './client';
import { recordingWavSeconds } from './recording-wav';

export async function saveRecording(
  scope: ProjectScope,
  requestId: string,
  bytes: Uint8Array,
  signal: AbortSignal,
) {
  recordingWavSeconds(bytes);
  const token = await waitForSessionToken(signal);
  const query = new URLSearchParams({
    projectId: scope.projectId,
    generation: String(scope.generation),
  });
  const response = await fetch(`/api/study/media/recordings?${query}`, {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: {
      'content-type': 'audio/wav',
      'x-sew-session': token,
      'x-recording-request-id': requestId,
    },
    body: new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }),
  });
  const parsed = apiEnvelopeSchema(apiResponses.recordingAsset).safeParse(await response.json());
  signal.throwIfAborted();
  if (!parsed.success) throw new Error('录音保存响应无效，请使用原录音重试。');
  if (!parsed.data.ok) throw new ApiError(parsed.data.error);
  if (!response.ok) throw new Error('录音保存失败，请使用原录音重试。');
  const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  signal.throwIfAborted();
  if (
    parsed.data.data.sha256 !== expected ||
    parsed.data.data.byteLength !== bytes.length ||
    parsed.data.data.seconds !== recordingWavSeconds(bytes)
  )
    throw new Error('录音保存回执与本地录音不一致。');
  return parsed.data.data;
}
