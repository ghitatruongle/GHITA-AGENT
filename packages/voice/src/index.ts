// --- Types ---
export type {
  AudioEncoding,
  AudioChunk,
  SttRequest,
  SttResult,
  TtsRequest,
  TtsResult,
  WakeWordEvent,
  WakeWordConfig,
  SttListener,
  TtsListener,
  WakeWordListener,
  AudioListener,
} from './types.js';

// --- Modules ---
export { SpeechToText } from './stt.js';
export { TextToSpeech, SilentTtsProvider } from './tts.js';
export type { TtsProvider } from './tts.js';
export { WakeWordDetector } from './wakeword.js';
export { AudioStream } from './stream.js';
export {
  VoiceActivityDetector,
  DEFAULT_VAD_CONFIG,
  type VadConfig,
  type VadEvent,
  type VadListener,
} from './vad.js';
export { AudioRingBuffer } from './audio-buffer.js';
export { TranscriptMerger, type PartialSegment } from './transcript-merger.js';

export const VOICE_VERSION = '0.0.0-preview';
