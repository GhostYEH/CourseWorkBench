import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrophoneRecorder, type RecordingState } from '../apps/learning/lib/microphone-recorder';
import { encodeRecordingWav, recordingWavSeconds } from '../apps/learning/lib/recording-wav';

const device = () => {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate: 16000,
    destination: {},
    createMediaStreamSource: () => source,
    createScriptProcessor: () => processor,
    createGain: () => gain,
    resume: vi.fn(async (): Promise<void> => undefined),
    close: vi.fn(async () => undefined),
  };
  const states: RecordingState[] = [];
  const recorder = new MicrophoneRecorder((state) => states.push(state), {
    getUserMedia: async () => stream,
    createContext: () => context as unknown as AudioContext,
  });
  const samples = (values: Float32Array) =>
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => values },
    } as unknown as AudioProcessingEvent);
  return { track, stream, processor, source, gain, context, states, recorder, samples };
};
afterEach(() => vi.useRealTimers());

describe('microphone ownership and real PCM recording', () => {
  it('encodes and validates the actual captured frames, then releases every device resource', async () => {
    const d = device();
    await d.recorder.start();
    expect(d.states.at(-1)?.state).toBe('recording');
    expect(d.gain.gain.value).toBe(0);
    const values = new Float32Array(1600);
    values.set([-1, 0, 0.5, 1]);
    d.samples(values);
    d.recorder.stop();
    const ready = d.states.at(-1);
    expect(ready?.state).toBe('ready');
    if (ready?.state !== 'ready') throw new Error('missing recording');
    expect(recordingWavSeconds(ready.bytes)).toBe(0.1);
    const pcm = new DataView(ready.bytes.buffer);
    expect([44, 46, 48, 50].map((offset) => pcm.getInt16(offset, true))).toEqual([
      -32768, 0, 16384, 32767,
    ]);
    expect(d.track.stop).toHaveBeenCalledOnce();
    expect(d.context.close).toHaveBeenCalledOnce();
    expect(d.processor.onaudioprocess).toBeNull();
    expect(d.source.disconnect).toHaveBeenCalledOnce();
    expect(d.gain.disconnect).toHaveBeenCalledOnce();
    d.recorder.dispose();
  });

  it('never starts capture when permission arrives after discard or disposal', async () => {
    for (const dispose of [false, true]) {
      const d = device();
      let grant!: (stream: MediaStream) => void;
      const context = vi.fn(() => d.context as unknown as AudioContext);
      const changed = vi.fn();
      const recorder = new MicrophoneRecorder(changed, {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
        createContext: context,
      });
      const pending = recorder.start();
      if (dispose) recorder.dispose();
      else recorder.discard();
      const calls = changed.mock.calls.length;
      grant(d.stream);
      await pending;
      expect(d.track.stop).toHaveBeenCalledOnce();
      expect(context).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledTimes(calls);
    }
  });

  it('release on cancellation during AudioContext resume prevents late capture', async () => {
    const d = device();
    let resume!: () => void;
    d.context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    const pending = d.recorder.start();
    await Promise.resolve();
    d.recorder.discard();
    resume();
    await pending;
    expect(d.states.at(-1)?.state).toBe('idle');
    expect(d.track.stop).toHaveBeenCalledOnce();
    expect(d.context.close).toHaveBeenCalledOnce();
  });

  it('handles a microphone ended while AudioContext resume is pending', async () => {
    const d = device();
    let resume!: () => void;
    d.context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    const pending = d.recorder.start();
    await Promise.resolve();
    d.track.onended?.();
    resume();
    await pending;
    expect(d.states.at(-1)?.state).toBe('error');
    expect(d.states.some((state) => state.state === 'recording')).toBe(false);
    expect(d.track.stop).toHaveBeenCalledOnce();
    expect(d.context.close).toHaveBeenCalledOnce();
    expect(d.processor.onaudioprocess).toBeNull();
    d.recorder.dispose();
  });

  it('stops at the actual duration limit and discards frames beyond it', async () => {
    const d = device();
    await d.recorder.start();
    d.samples(new Float32Array(16000 * 300 + 10));
    const ready = d.states.at(-1);
    if (ready?.state !== 'ready') throw new Error('missing bounded recording');
    expect(ready.seconds).toBe(300);
    expect(recordingWavSeconds(ready.bytes)).toBe(300);
    expect(d.track.stop).toHaveBeenCalledOnce();
    d.recorder.dispose();
  });

  it('handles a removed microphone and the wall-clock limit without leaking resources', async () => {
    vi.useFakeTimers();
    for (const removed of [true, false]) {
      const d = device();
      await d.recorder.start();
      d.samples(new Float32Array(16000));
      if (removed) d.track.onended?.();
      else vi.advanceTimersByTime(300000);
      expect(d.states.at(-1)?.state).toBe('ready');
      expect(d.track.stop).toHaveBeenCalledOnce();
      d.recorder.dispose();
    }
  });

  it('rejects malformed framing, lying durations, unsupported formats and empty captures', () => {
    const valid = encodeRecordingWav([new Float32Array(16000)], 16000);
    for (const offset of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
      const corrupt = valid.slice();
      corrupt[offset] = corrupt[offset]! ^ 255;
      expect(() => recordingWavSeconds(corrupt)).toThrow();
    }
    expect(() => recordingWavSeconds(valid.subarray(0, 45))).toThrow();
    expect(() => encodeRecordingWav([], 16000)).toThrow();
    expect(() => encodeRecordingWav([Float32Array.of(NaN)], 16000)).toThrow();
  });
});
