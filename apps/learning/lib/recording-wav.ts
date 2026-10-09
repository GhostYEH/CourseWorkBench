/** The recorder writes bounded mono PCM16; the server verifies the same closed format. */
export const RECORDING_MAX_BYTES = 16 * 1024 * 1024;
export const RECORDING_MAX_SECONDS = 300;

export const encodeRecordingWav = (chunks: Float32Array[], sampleRate: number): Uint8Array => {
  const frames = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    frames < 1 ||
    frames / sampleRate < 0.1 ||
    frames / sampleRate > RECORDING_MAX_SECONDS ||
    44 + frames * 2 > RECORDING_MAX_BYTES
  )
    throw new Error('录音为空或超过时长、大小上限。');
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  tag(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, frames * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const value of chunk) {
      if (!Number.isFinite(value)) throw new Error('录音采样无效。');
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  return bytes;
};

export const recordingWavSeconds = (bytes: Uint8Array): number => {
  const invalid = () => new Error('录音必须是大小、时长合规的单声道 PCM16 WAV。');
  if (bytes.length <= 44 || bytes.length > RECORDING_MAX_BYTES || (bytes.length - 44) % 2)
    throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, value: string) =>
    [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  const rate = view.getUint32(24, true);
  if (
    !tag(0, 'RIFF') ||
    !tag(8, 'WAVE') ||
    !tag(12, 'fmt ') ||
    !tag(36, 'data') ||
    view.getUint32(4, true) !== bytes.length - 8 ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    rate < 8000 ||
    rate > 96000 ||
    view.getUint32(28, true) !== rate * 2 ||
    view.getUint32(40, true) !== bytes.length - 44
  )
    throw invalid();
  const seconds = (bytes.length - 44) / 2 / rate;
  if (seconds < 0.1 || seconds > RECORDING_MAX_SECONDS) throw invalid();
  return seconds;
};
