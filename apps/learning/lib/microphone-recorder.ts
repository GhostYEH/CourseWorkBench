import { encodeRecordingWav, RECORDING_MAX_BYTES, RECORDING_MAX_SECONDS } from './recording-wav';

export type RecordingState =
  | { state: 'idle' | 'requesting' | 'recording' }
  | { state: 'ready'; bytes: Uint8Array; seconds: number }
  | { state: 'error'; message: string };

interface RecordingEnvironment {
  getUserMedia(): Promise<MediaStream>;
  createContext(): AudioContext;
}

/** Owns device resources and rejects permission results arriving after cancellation/unmount. */
export class MicrophoneRecorder {
  private epoch = 0;
  private state: RecordingState = { state: 'idle' };
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chunks: Float32Array[] = [];
  private frames = 0;
  private disposed = false;

  constructor(
    private readonly changed: (state: RecordingState) => void,
    private readonly environment: RecordingEnvironment = {
      getUserMedia: () =>
        navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false }),
      createContext: () => new AudioContext({ sampleRate: 16000 }),
    },
  ) {}

  private publish(state: RecordingState): void {
    this.state = state;
    if (!this.disposed) this.changed(state);
  }

  private release(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.gain?.disconnect();
    this.processor = null;
    this.source = null;
    this.gain = null;
    if (this.stream)
      for (const track of this.stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context) void context.close().catch(() => undefined);
  }

  async start(): Promise<void> {
    if (this.disposed || this.state.state === 'requesting' || this.state.state === 'recording')
      return;
    this.discard();
    const epoch = ++this.epoch;
    this.publish({ state: 'requesting' });
    try {
      const stream = await this.environment.getUserMedia();
      if (this.disposed || epoch !== this.epoch) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      if (
        stream.getTracks().length === 0 ||
        stream.getTracks().some((track) => track.readyState === 'ended')
      )
        throw new Error('麦克风已断开');
      const context = this.environment.createContext();
      this.context = context;
      const source = context.createMediaStreamSource(stream);
      this.source = source;
      const processor = context.createScriptProcessor(2048, 1, 1);
      this.processor = processor;
      const gain = context.createGain();
      this.gain = gain;
      gain.gain.value = 0;
      const maximumFrames = Math.min(
        Math.floor(context.sampleRate * RECORDING_MAX_SECONDS),
        Math.floor((RECORDING_MAX_BYTES - 44) / 2),
      );
      processor.onaudioprocess = (event) => {
        if (epoch !== this.epoch || this.state.state !== 'recording') return;
        const input = event.inputBuffer.getChannelData(0);
        const length = Math.min(input.length, maximumFrames - this.frames);
        if (length > 0) {
          this.chunks.push(input.slice(0, length));
          this.frames += length;
        }
        if (this.frames >= maximumFrames) this.stop();
      };
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (epoch !== this.epoch) return;
          if (this.state.state === 'recording') this.stop();
          else {
            ++this.epoch;
            this.release();
            this.publish({ state: 'error', message: '麦克风已断开，请检查设备后重新开始。' });
          }
        };
      });
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);
      await context.resume();
      if (this.disposed || epoch !== this.epoch) return;
      if (stream.getTracks().some((track) => track.readyState === 'ended'))
        throw new Error('麦克风已断开');
      this.publish({ state: 'recording' });
      this.timer = setTimeout(() => this.stop(), RECORDING_MAX_SECONDS * 1000);
    } catch {
      if (this.disposed || epoch !== this.epoch) return;
      this.release();
      this.publish({ state: 'error', message: '无法开始录音，请检查麦克风权限和设备后重试。' });
    }
  }

  stop(): void {
    if (this.state.state !== 'recording') return;
    const rate = this.context!.sampleRate;
    ++this.epoch;
    this.release();
    try {
      const bytes = encodeRecordingWav(this.chunks, rate);
      this.publish({ state: 'ready', bytes, seconds: this.frames / rate });
    } catch {
      this.publish({ state: 'error', message: '没有录到有效音频，请重新录制。' });
    } finally {
      this.chunks = [];
      this.frames = 0;
    }
  }

  discard(): void {
    ++this.epoch;
    this.release();
    this.chunks = [];
    this.frames = 0;
    this.publish({ state: 'idle' });
  }

  dispose(): void {
    this.disposed = true;
    this.discard();
  }
}
