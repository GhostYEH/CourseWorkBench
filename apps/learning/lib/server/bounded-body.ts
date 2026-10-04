export type BodyFailure = 'too_large' | 'missing' | 'unreadable';

/** Count actual streamed bytes; Content-Length is only an early rejection hint. */
export const readBoundedBody = async (
  request: Request,
  maxBytes: number,
  failure: (reason: BodyFailure) => Error,
): Promise<Uint8Array> => {
  const length = request.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    throw failure('too_large');
  }
  if (!request.body) throw failure('missing');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        throw failure('unreadable');
      }
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw failure('too_large');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
