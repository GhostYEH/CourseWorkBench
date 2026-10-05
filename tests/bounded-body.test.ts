import { describe, expect, it } from 'vitest';
import { readBoundedBody } from '../apps/learning/lib/server/bounded-body';

const failure = (reason: string) => new Error(reason);
const request = (body: ReadableStream<Uint8Array>, headers?: HeadersInit) =>
  new Request('http://localhost/body', {
    method: 'POST',
    body,
    headers,
    duplex: 'half',
  } as RequestInit);

describe('bounded streamed HTTP bodies', () => {
  it('rejects actual bytes exceeding a misleading Content-Length and cancels the stream', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readBoundedBody(request(body, { 'content-length': '1' }), 5, failure),
    ).rejects.toThrow('too_large');
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
  it('accepts exactly the byte limit across chunks and releases a failed reader', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    expect(await readBoundedBody(request(body), 3, failure)).toEqual(new Uint8Array([1, 2, 3]));
    expect(body.locked).toBe(false);
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream fault'));
      },
    });
    await expect(readBoundedBody(request(broken), 3, failure)).rejects.toThrow('unreadable');
    expect(broken.locked).toBe(false);
  });
});
