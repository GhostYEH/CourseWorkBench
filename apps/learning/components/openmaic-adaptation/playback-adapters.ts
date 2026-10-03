import type { Action, SpeechAction } from '@openmaic/dsl';

/** Narrow M0 boundary used by the copied OpenMAIC playback engine. */
export interface AudioPlayer {
  play(audioId: string, legacyUrl?: string): Promise<boolean>;
  onEnded(callback: () => void): void;
  isPlaying(): boolean;
  hasActiveAudio(): boolean;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface ActionExecutor {
  execute(action: Action, options?: { silent?: boolean }): Promise<void> | void;
  clearEffects(): void;
  resetPlaybackVisualState(): void;
}

export type LegacySpeechAction = SpeechAction & { audioUrl?: string };

/** The fixed M0 lesson has no action records; unsupported actions fail closed. */
export const createM0ActionExecutor = (): ActionExecutor => ({
  execute(action) {
    throw new Error(`M0 playback does not enable the upstream action "${action.type}".`);
  },
  clearEffects() {},
  resetPlaybackVisualState() {},
});

export const createM0AudioPlayer = (): AudioPlayer => ({
  async play() { return false; },
  onEnded() {},
  isPlaying() { return false; },
  hasActiveAudio() { return false; },
  pause() {},
  resume() {},
  stop() {},
});

export const useCanvasStore = {
  getState: () => ({ setWhiteboardOpen: (_open: boolean) => {}, pauseVideo: () => {} }),
};

export const useSettingsStore = {
  getState: () => ({
    ttsEnabled: false,
    ttsProviderId: 'disabled',
    ttsProvidersConfig: { 'browser-native-tts': undefined as unknown },
    ttsMuted: true,
    ttsVolume: 0,
    ttsSpeed: 1,
    ttsVoice: 'default',
  }),
};

export const isTTSProviderEnabled = (_providerId?: string, _config?: unknown): boolean => false;
export const detectSpeechLang = (_text: string): string => 'zh-CN';
export const createLogger = (name: string) => ({
  info: (...values: unknown[]) => console.info(`[${name}]`, ...values),
  warn: (...values: unknown[]) => console.warn(`[${name}]`, ...values),
  error: (...values: unknown[]) => console.error(`[${name}]`, ...values),
});
