// Captures desktop screen and streams as base64 JPEG over Socket.io
// v0.0.1 (T3.1): screenshot-desktop npm package removed from the dependency
// tree (GHSA-mh99 build-time glob traversal advisory). Capture is now
// injectable: callers pass a native provider (desktop sidecar wires the
// bundled Windows C# helper bat; Tauri exposes computer_screenshot for the UI).

import type { ScreenStreamConfig } from './types.js';

const DEFAULT_CONFIG: ScreenStreamConfig = {
  quality: 60,
  interval: 1000,
  maxWidth: 1280,
};

export interface ScreenCaptureOptions {
  /** Injected capture provider returning JPEG bytes for one screen frame. */
  capture?: () => Promise<Buffer | Uint8Array>;
}

export class ScreenCapture {
  private config: ScreenStreamConfig;
  private captureFn?: () => Promise<Buffer | Uint8Array>;
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private isStreaming = false;
  private onFrame?: (imageBase64: string) => void;

  constructor(config: Partial<ScreenStreamConfig> = {}, options: ScreenCaptureOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.captureFn = options.capture;
  }

  /**
   * Capture a single screenshot and return as base64
   */
  async captureScreen(): Promise<string> {
    try {
      let imgBuffer: Buffer | Uint8Array;
      if (this.captureFn) {
        imgBuffer = await this.captureFn();
      } else {
        throw new Error(
          'No capture provider injected — pass { capture } to the ScreenCapture constructor',
        );
      }
      // Cross-environment base64 encoding (works in both Node.js and browser)
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(imgBuffer)) {
        return imgBuffer.toString('base64');
      }
      // Browser-safe: Uint8Array → base64 via btoa
      const bytes =
        imgBuffer instanceof Uint8Array ? imgBuffer : new Uint8Array(imgBuffer as ArrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i] as number);
      }
      return btoa(binary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ScreenCapture] Failed to capture screen:', message);
      throw new Error(`Screen capture failed: ${message}`);
    }
  }

  /**
   * Start continuous screen streaming
   */
  startStream(onFrame: (imageBase64: string) => void): void {
    if (this.isStreaming) {
      this.stopStream();
    }
    this.onFrame = onFrame;
    this.isStreaming = true;
    void this.emitFrame();
    this.streamTimer = setInterval(() => {
      void this.emitFrame();
    }, this.config.interval);
    if (this.streamTimer && typeof this.streamTimer === 'object' && 'unref' in this.streamTimer) {
      this.streamTimer.unref();
    }
  }

  /**
   * Stop continuous screen streaming
   */
  stopStream(): void {
    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
    this.isStreaming = false;
    this.onFrame = undefined;
  }

  updateConfig(config: Partial<ScreenStreamConfig>): void {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.isStreaming && this.onFrame) {
      const currentCallback = this.onFrame;
      this.stopStream();
      this.startStream(currentCallback);
    }
  }

  getConfig(): ScreenStreamConfig {
    return { ...this.config };
  }

  get streaming(): boolean {
    return this.isStreaming;
  }

  dispose(): void {
    this.stopStream();
  }

  // --- Private ---

  private async emitFrame(): Promise<void> {
    if (!this.isStreaming || !this.onFrame) return;
    try {
      const base64 = await this.captureScreen();
      this.onFrame(base64);
    } catch {
      // Silently skip frame on capture failure — don't crash the stream
    }
  }
}
