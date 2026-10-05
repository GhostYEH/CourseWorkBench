import { describe, expect, it } from 'vitest';
import { readBoundedJson } from '../apps/learning/lib/server/bounded-json';

const failure = (reason: string) => new Error(reason);
const request = (body: BodyInit | null, headers?: HeadersInit) =>
  new Request('http://localhost/json', {
    method: 'POST',
    body,
    headers,
    duplex: 'half',
  } as RequestInit);
const bytes = (...chunks: number[][]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });

describe('bounded UTF-8/JSON HTTP bodies', () => {
  it('decodes a valid JSON body streamed across chunks', async () => {
    const text = '{"a":[1,2],"b":"中"}';
    const chunks: number[][] = [];
    for (let i = 0; i < text.length; i += 3) {
      chunks.push([...new TextEncoder().encode(text.slice(i, i + 3))]);
    }
    expect(await readBoundedJson(request(bytes(...chunks)), 64, failure)).toEqual({
      a: [1, 2],
      b: '中',
    });
  });
  it('rejects actual bytes over the limit, a missing body and an unreadable stream', async () => {
    await expect(readBoundedJson(request(bytes([1, 2, 3, 4, 5, 6])), 5, failure)).rejects.toThrow(
      'too_large',
    );
    await expect(readBoundedJson(request(null), 5, failure)).rejects.toThrow('missing');
    await expect(
      readBoundedJson(
        request(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('stream fault'));
            },
          }),
        ),
        5,
        failure,
      ),
    ).rejects.toThrow('unreadable');
  });
  it('rejects invalid UTF-8 instead of substituting replacement characters', async () => {
    // 0xC4 0xE5 is not a valid UTF-8 sequence; a lenient decoder would hide the corruption.
    await expect(readBoundedJson(request(bytes([0xc4, 0xe5])), 5, failure)).rejects.toThrow(
      'invalid_utf8',
    );
  });
  it('rejects malformed and empty JSON text and carries the codec diagnostic', async () => {
    await expect(
      readBoundedJson(request('{'), 5, (reason, detail) => new Error(`${reason}:${detail ?? ''}`)),
    ).rejects.toThrow('invalid_json:http_json_body');
    await expect(
      readBoundedJson(request(bytes([...new TextEncoder().encode('   ')])), 5, failure),
    ).rejects.toThrow('invalid_json');
  });
});
