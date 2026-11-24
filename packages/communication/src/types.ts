import type { DeviceInfo } from '@ghita/shared';

// --- Server Configuration ---
export interface ServerConfig {
  port: number;
  host?: string;
  cors?: {
    origin:
      | string
      | string[]
      | ((
          origin: string | undefined,
          callback: (err: Error | null, allow?: boolean) => void,
        ) => void);
    methods?: string[];
  };
  pairedDevicesFile?: string;
  /** Track S3 P3: mobile chat_chunk micro-batch bounds (defaults: 16 chars / 10 ms). */
  chatChunkBatch?: {
    maxChars?: number;
    maxDelayMs?: number;
  };
}

// --- Paired Device (extended from shared DeviceInfo) ---
export interface PairedDevice extends DeviceInfo {
  socketId: string;
  pairedAt: number;
  secret?: string | null;
}

// --- Command Payload ---
export interface CommandPayload {
  action: string;
  params?: Record<string, unknown>;
  timestamp?: number;
  [key: string]: unknown;
}

// --- Screen Stream Configuration ---
export interface ScreenStreamConfig {
  /** JPEG quality 1-100 */
  quality: number;
  /** Milliseconds between frames */
  interval: number;
  /** Max width in pixels (resize for bandwidth) */
  maxWidth: number;
}

// --- Server Events (typed callback signatures) ---
export interface ServerEvents {
  onDeviceConnected?: (device: PairedDevice) => void;
  onDeviceDisconnected?: (deviceId: string) => void;
  onCommand?: (deviceId: string, payload: CommandPayload) => void;
  onChat?: (deviceId: string, text: string) => void;
  onApprove?: (deviceId: string) => void;
  onReject?: (deviceId: string) => void;
  onApproveCommand?: (deviceId: string, data: { id: string }) => void;
  onRejectCommand?: (deviceId: string, data: { id: string }) => void;
  onError?: (error: Error) => void;
}

// --- Pairing State ---
export interface PairingState {
  code: string;
  expiresAt: number;
  isActive: boolean;
}
