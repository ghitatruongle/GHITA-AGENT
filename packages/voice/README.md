# @ghita/voice

![Version](https://img.shields.io/badge/version-0.0.4-blue)

Voice I/O pipeline for Ghita Agent -- STT (Whisper), TTS abstraction, wake-word detection, VAD (voice activity detection), and audio streaming.

## Key Features

- **Speech-to-text** -- Whisper-based transcription for voice-command input.
- **Text-to-speech** -- pluggable TTS backends for agent voice responses.
- **Wake-word detection** -- always-listening mode with customizable wake-word triggers.
- **VAD integration** -- voice activity detection to filter silence and reduce processing.
- **Audio streaming** -- real-time audio buffer management with chunked transmission.

## Installation

```bash
pnpm install --filter @ghita/voice
```

## Usage

```typescript
import { STTEngine, TTSEngine } from '@ghita/voice';

const stt = new STTEngine();
const transcript = await stt.transcribe(audioBuffer);

const tts = new TTSEngine();
const audio = await tts.synthesize('Code review complete');
```

## API Docs

Generated via TypeDoc: `pnpm build:docs`
