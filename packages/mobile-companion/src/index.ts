// @ghita/mobile-companion -- Public API

export { BluetoothPairing } from './bluetooth.js';
export { NetworkDiscovery } from './network-discovery.js';
export { PushNotificationBridge } from './push-bridge.js';
export { detectCapabilities } from './device-capabilities.js';
export type {
  BluetoothDevice,
  NetworkDevice,
  PushNotification,
  DeviceCapabilities,
} from './types.js';

export const MOBILE_COMPANION_VERSION = '0.0.0';
