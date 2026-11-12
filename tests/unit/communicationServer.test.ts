import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommunicationServer } from '../../packages/communication/src/server.js';
import { SOCKET_EVENTS } from '../../packages/shared/src/constants.js';

// Mocks

import {
  mockSocketOnHandlers,
  mockSocketEmit,
  mockSocketOn,
  mockSocket,
  mockIoSocketOn,
  mockIoEmit,
  mockIoOn,
  mockIo,
} from './socket-io-mock.js';

let mockIoListenCallback: (() => void) | null = null;
let mockIoErrorCallback: ((err: Error) => void) | null = null;

// Mock node:http
const mockHttpServerListen = vi.fn((_port: number, _host: string, cb: () => void) => {
  mockIoListenCallback = cb;
  // Don't call cb immediately — start() returns a promise that resolves when listen callback fires
});
const mockHttpServerClose = vi.fn((cb: () => void) => {
  cb();
});
vi.mock('node:http', () => ({
  createServer: vi.fn(() => ({
    on: vi.fn((event: string, handler: (err: Error) => void) => {
      if (event === 'error') {
        mockIoErrorCallback = handler;
      }
    }),
    listeners: vi.fn(() => []),
    removeAllListeners: vi.fn(),
    emit: vi.fn(),
    listen: mockHttpServerListen,
    close: mockHttpServerClose,
  })),
}));

// Helpers

function createServer(
  config?: Record<string, unknown>,
  options?: { capture?: () => Promise<Buffer | Uint8Array> },
): CommunicationServer {
  return new CommunicationServer(
    config as ConstructorParameters<typeof CommunicationServer>[0],
    options,
  );
}

function simulateConnection(socketOverrides?: Partial<typeof mockSocket>): typeof mockSocket {
  const socket = { ...mockSocket, ...socketOverrides };
  // Re-trigger the connection handler with this socket
  // We need to access the handler that was registered
  const connectionHandler = mockIoOn.mock.calls.find((call) => call[0] === 'connection')?.[1] as
    | ((s: typeof mockSocket) => void)
    | undefined;

  if (connectionHandler) {
    // Reset socket event handlers for the new socket
    mockSocketOnHandlers.clear();
    mockSocketOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      mockSocketOnHandlers.set(event, handler);
      return socket;
    });
    socket.on = mockSocketOn;
    socket.id = socketOverrides?.id ?? 'test-socket-1';
    connectionHandler(socket);
  }
  return socket;
}

function triggerSocketEvent(event: string, ...args: unknown[]): void {
  const handler = mockSocketOnHandlers.get(event);
  if (handler) {
    handler(...args);
  }
}

// Tests

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockIoListenCallback = null;
  mockIoErrorCallback = null;
  mockSocketOnHandlers.clear();

  // Re-apply mock implementations after clearAllMocks
  mockSocketOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    mockSocketOnHandlers.set(event, handler);
    return mockSocket;
  });
  mockSocket.on = mockSocketOn;
  mockSocket.emit = mockSocketEmit;
  mockIoOn.mockImplementation((event: string, handler: (socket: typeof mockSocket) => void) => {
    if (event === 'connection') {
      handler(mockSocket);
    }
  });
  mockIo.on = mockIoOn;
  mockIo.emit = mockIoEmit;
  mockIo.to.mockImplementation(() => ({ emit: mockIoEmit }));
});

afterEach(async () => {
  vi.useRealTimers();
});

describe('constructor', () => {
  it('should create a CommunicationServer instance', () => {
    const server = createServer();
    expect(server).toBeInstanceOf(CommunicationServer);
  });

  it('should apply default config when no config provided', () => {
    const server = createServer();
    const addr = server.getAddress();
    expect(addr.port).toBe(8080);
    expect(addr.host).toBe('0.0.0.0');
  });

  it('should merge custom config with defaults', () => {
    const server = createServer({ port: 9090, host: '127.0.0.1' });
    const addr = server.getAddress();
    expect(addr.port).toBe(9090);
    expect(addr.host).toBe('127.0.0.1');
  });

  it('should initialize PairingManager', () => {
    const server = createServer();
    expect(server.pairing).toBeDefined();
    const code = server.pairing.getState();
    expect(code.code).toHaveLength(6);
    expect(code.isActive).toBe(true);
  });

  it('should be not running initially', () => {
    const server = createServer();
    expect(server.isRunning).toBe(false);
  });

  it('should have 0 connected devices initially', () => {
    const server = createServer();
    expect(server.deviceCount).toBe(0);
  });
});

describe('start() / stop()', () => {
  it('should start the server and create Socket.io instance', async () => {
    const server = createServer();
    const startPromise = server.start();

    // Simulate the HTTP server listen callback completing
    const listenCb = mockIoListenCallback;
    if (listenCb) listenCb();

    await startPromise;

    expect(server.isRunning).toBe(true);
    // Socket.io Server should have been instantiated
    const { Server: MockServer } = await vi.importActual<{ Server: unknown }>('socket.io');
    expect(MockServer).toBeDefined();
  });

  it('should warn and return if already running', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    // Try starting again
    await server.start();
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    consoleWarnSpy.mockRestore();
  });

  it('should stop the server and cleanup resources', async () => {
    const server = createServer();

    const startPromise = server.start();
    const listenCb = mockIoListenCallback;
    if (listenCb) listenCb();
    await startPromise;

    expect(server.isRunning).toBe(true);

    await server.stop();
    expect(server.isRunning).toBe(false);
    expect(server.deviceCount).toBe(0);
  });

  it('should reject start if HTTP server not initialized', async () => {
    const server = createServer();
    const startPromise = server.start();

    // Trigger an error on the HTTP server
    const errCb = mockIoErrorCallback;
    if (errCb) {
      errCb(new Error('Port in use'));
    }

    await expect(startPromise).rejects.toThrow('Port in use');
  });
});

describe('getAddress()', () => {
  it('should return host and port', () => {
    const server = createServer({ port: 3000, host: '192.168.1.1' });
    expect(server.getAddress()).toEqual({ host: '192.168.1.1', port: 3000 });
  });

  it('should default host to 0.0.0.0 when not set in custom config', () => {
    const server = createServer({ port: 8080 });
    expect(server.getAddress().host).toBe('0.0.0.0');
  });
});

describe('setCallbacks()', () => {
  it('should register event callbacks that fire on events', async () => {
    const server = createServer();
    const onCommand = vi.fn();
    server.setCallbacks({ onCommand });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });
    triggerSocketEvent(SOCKET_EVENTS.COMMAND, { action: 'test', params: {} });

    expect(onCommand).toHaveBeenCalled();
  });

  it('should merge callbacks with different events', async () => {
    const server = createServer();
    const onCommand = vi.fn();
    const onChat = vi.fn();

    server.setCallbacks({ onCommand });
    server.setCallbacks({ onChat });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });
    triggerSocketEvent(SOCKET_EVENTS.COMMAND, { action: 'test', params: {} });
    triggerSocketEvent(SOCKET_EVENTS.CHAT, { text: 'hello' });

    // Both callbacks should fire (merged from separate calls)
    expect(onCommand).toHaveBeenCalled();
    expect(onChat).toHaveBeenCalled();
  });

  it('should overwrite callbacks with the same key', async () => {
    const server = createServer();
    const onCommand1 = vi.fn();
    const onCommand2 = vi.fn();

    server.setCallbacks({ onCommand: onCommand1 });
    server.setCallbacks({ onCommand: onCommand2 });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });
    triggerSocketEvent(SOCKET_EVENTS.COMMAND, { action: 'test', params: {} });

    // onCommand1 should have been overwritten by onCommand2
    expect(onCommand1).not.toHaveBeenCalled();
    expect(onCommand2).toHaveBeenCalled();
  });
});

describe('getConnectedDevices()', () => {
  it('should return an empty array when no devices connected', () => {
    const server = createServer();
    expect(server.getConnectedDevices()).toEqual([]);
  });

  it('should return connected devices after pairing', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    // Simulate a pairing event
    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    const devices = server.getConnectedDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.platform).toBe('android');
    expect(devices[0]!.connected).toBe(true);
  });
});

describe('deviceCount', () => {
  it('should reflect the number of paired devices', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    expect(server.deviceCount).toBe(0);

    // Pair one device
    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });
    expect(server.deviceCount).toBe(1);

    // Pair another device with a different socket
    const pairCode2 = server.pairing.getCode();
    simulateConnection({ id: 'test-socket-2' });
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode2 });
    expect(server.deviceCount).toBe(2);
  });
});

describe('broadcastScreenshot()', () => {
  it('should not broadcast when server is not running', async () => {
    const server = createServer();
    await server.broadcastScreenshot();
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  it('should not broadcast when no devices connected', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    await server.broadcastScreenshot();
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  it('should broadcast screenshot to connected devices', async () => {
    // Inject a capture provider (screenshot-desktop removed in T3.1)
    const server = createServer({}, { capture: async () => Buffer.from('ghita-fake-jpeg') });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    // Pair a device
    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    await server.broadcastScreenshot();
    expect(mockIoEmit).toHaveBeenCalledWith(
      SOCKET_EVENTS.SCREEN_STREAM,
      expect.objectContaining({
        image: expect.any(String),
        timestamp: expect.any(Number),
      }),
    );
  });
});

describe('broadcastChat()', () => {
  it('should not broadcast when server is not running', () => {
    const server = createServer();
    server.broadcastChat('hello');
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  it('should broadcast chat message to all connected devices', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    server.broadcastChat('Hello from desktop!');
    expect(mockIoEmit).toHaveBeenCalledWith(
      SOCKET_EVENTS.CHAT,
      expect.objectContaining({
        text: 'Hello from desktop!',
        timestamp: expect.any(Number),
      }),
    );
  });
});

describe('broadcastStatus()', () => {
  it('should not broadcast when server is not running', () => {
    const server = createServer();
    server.broadcastStatus({ status: 'idle' });
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  it('should broadcast status update to all connected devices', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    server.broadcastStatus({ status: 'working', task: 'coding' });
    expect(mockIoEmit).toHaveBeenCalledWith(SOCKET_EVENTS.STATUS, {
      status: 'working',
      task: 'coding',
    });
  });
});

// Socket Event Handling

describe('pairing flow (PAIR event)', () => {
  it('should emit error when pairing code is missing', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    triggerSocketEvent(SOCKET_EVENTS.PAIR, {});
    expect(mockSocketEmit).toHaveBeenCalledWith(SOCKET_EVENTS.ERROR, {
      message: 'Pairing code or device ID is required',
    });
  });

  it('should emit error when pairing code is invalid', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: 'WRONG' });
    expect(mockSocketEmit).toHaveBeenCalledWith(SOCKET_EVENTS.ERROR, {
      message: 'Invalid or expired pairing code',
    });
  });

  it('should pair successfully with valid code', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    // Should emit pair_confirm
    expect(mockSocketEmit).toHaveBeenCalledWith(SOCKET_EVENTS.PAIR_CONFIRM, {
      deviceName: 'GHITA Desktop',
      deviceId: expect.any(String),
      authToken: expect.any(String),
    });

    // Device should be registered
    expect(server.deviceCount).toBe(1);
  });

  it('should regenerate pairing code after successful pair', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const oldCode = server.pairing.getCode();

    // Use the code to pair
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: oldCode });

    // Code should have changed
    const newCode = server.pairing.getCode();
    expect(newCode).not.toBe(oldCode);
  });
});

describe('COMMAND event', () => {
  it('should trigger onCommand callback for paired devices', async () => {
    const server = createServer();
    const onCommand = vi.fn();
    server.setCallbacks({ onCommand });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    // Pair first
    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    // Send command
    const cmdPayload = { action: 'run_code', params: { file: 'test.ts' }, timestamp: Date.now() };
    triggerSocketEvent(SOCKET_EVENTS.COMMAND, cmdPayload);

    expect(onCommand).toHaveBeenCalledWith(
      expect.any(String), // deviceId
      cmdPayload,
    );
  });

  it('should not trigger onCommand for unpaired devices', async () => {
    const server = createServer();
    const onCommand = vi.fn();
    server.setCallbacks({ onCommand });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    // Send command without pairing
    triggerSocketEvent(SOCKET_EVENTS.COMMAND, {
      action: 'run_code',
      params: {},
      timestamp: Date.now(),
    });

    expect(onCommand).not.toHaveBeenCalled();
  });

  it('should support and pass custom parameters in the command payload', async () => {
    const server = createServer();
    const onCommand = vi.fn();
    server.setCallbacks({ onCommand });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    // Pair first
    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    // Send command with custom parameters
    const cmdPayload = {
      action: 'custom_action',
      params: {
        custom_string: 'val1',
        custom_number: 42,
        custom_bool: true,
        custom_array: [1, 2, 3],
        custom_object: { nested: 'val' },
      },
      timestamp: Date.now(),
    };
    triggerSocketEvent(SOCKET_EVENTS.COMMAND, cmdPayload);

    expect(onCommand).toHaveBeenCalledWith(
      expect.any(String), // deviceId
      expect.objectContaining({
        action: 'custom_action',
        params: expect.objectContaining({
          custom_string: 'val1',
          custom_number: 42,
          custom_bool: true,
          custom_array: expect.arrayContaining([1, 2, 3]),
          custom_object: expect.objectContaining({ nested: 'val' }),
        }),
      }),
    );
  });
});

describe('CHAT event', () => {
  it('should trigger onChat callback for paired devices', async () => {
    const server = createServer();
    const onChat = vi.fn();
    server.setCallbacks({ onChat });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    // Pair first
    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    // Send chat
    triggerSocketEvent(SOCKET_EVENTS.CHAT, { text: 'Hello!' });
    expect(onChat).toHaveBeenCalledWith(expect.any(String), 'Hello!');
  });

  it('should not trigger onChat for empty text', async () => {
    const server = createServer();
    const onChat = vi.fn();
    server.setCallbacks({ onChat });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    triggerSocketEvent(SOCKET_EVENTS.CHAT, {});
    expect(onChat).not.toHaveBeenCalled();
  });
});

describe('APPROVE / REJECT events', () => {
  it('should trigger onApprove callback for paired devices', async () => {
    const server = createServer();
    const onApprove = vi.fn();
    server.setCallbacks({ onApprove });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    triggerSocketEvent(SOCKET_EVENTS.APPROVE);
    expect(onApprove).toHaveBeenCalledWith(expect.any(String));
  });

  it('should trigger onReject callback for paired devices', async () => {
    const server = createServer();
    const onReject = vi.fn();
    server.setCallbacks({ onReject });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    triggerSocketEvent(SOCKET_EVENTS.REJECT);
    expect(onReject).toHaveBeenCalledWith(expect.any(String));
  });
});

describe('SCREENSHOT event', () => {
  it('should respond with screenshot to paired devices', async () => {
    // Use real timers for this async test (injectable capture chain)
    vi.useRealTimers();

    const server = createServer({}, { capture: async () => Buffer.from('ghita-fake-jpeg') });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });
    mockSocketEmit.mockClear(); // Clear pair_confirm emit

    // Trigger screenshot request
    triggerSocketEvent(SOCKET_EVENTS.SCREENSHOT);
    // Give the async handler time to complete (dynamic import + screenshot mock)
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockSocketEmit).toHaveBeenCalledWith(
      SOCKET_EVENTS.SCREEN_STREAM,
      expect.objectContaining({
        image: expect.any(String),
        timestamp: expect.any(Number),
      }),
    );
  });

  it('should emit error when screenshot capture fails', async () => {
    // Use real timers for this async test
    vi.useRealTimers();

    // Inject a capture provider that rejects (screenshot-desktop removed in T3.1)
    const server = createServer(
      {},
      {
        capture: async () => {
          throw new Error('Capture denied');
        },
      },
    );

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });
    mockSocketEmit.mockClear(); // Clear pair_confirm emit

    // Trigger screenshot request
    triggerSocketEvent(SOCKET_EVENTS.SCREENSHOT);
    // Give the async handler time to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockSocketEmit).toHaveBeenCalledWith(SOCKET_EVENTS.ERROR, {
      message: 'Failed to capture screenshot',
    });
  });
});

describe('PONG event (keepalive)', () => {
  it('should update lastSeen for paired devices', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    const devices = server.getConnectedDevices();
    const initialLastSeen = devices[0]!.lastSeen;

    // Advance time and send pong
    vi.advanceTimersByTime(1000);
    vi.setSystemTime(Date.now() + 1000);
    triggerSocketEvent(SOCKET_EVENTS.PONG);

    const devicesAfter = server.getConnectedDevices();
    expect(devicesAfter[0]!.lastSeen).toBeGreaterThan(initialLastSeen);
  });
});

describe('DISCONNECT event', () => {
  it('should remove device on disconnect', async () => {
    const server = createServer();
    const onDeviceDisconnected = vi.fn();
    server.setCallbacks({ onDeviceDisconnected });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    expect(server.deviceCount).toBe(1);

    triggerSocketEvent(SOCKET_EVENTS.DISCONNECT, 'client close');
    expect(server.deviceCount).toBe(0);
    expect(onDeviceDisconnected).toHaveBeenCalledWith(expect.any(String));
  });
});

describe('setCallbacks — event callbacks', () => {
  it('should trigger onDeviceConnected after successful pairing', async () => {
    const server = createServer();
    const onDeviceConnected = vi.fn();
    server.setCallbacks({ onDeviceConnected });

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode });

    expect(onDeviceConnected).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        name: expect.stringContaining('Mobile-'),
        platform: 'android',
      }),
    );
  });

  it('should trigger onError callback on server error', async () => {
    const server = createServer();
    const onError = vi.fn();
    server.setCallbacks({ onError });

    const startPromise = server.start();

    // Trigger HTTP server error
    const errCb = mockIoErrorCallback;
    if (errCb) {
      errCb(new Error('ECONNRESET'));
    }

    await expect(startPromise).rejects.toThrow('ECONNRESET');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('session resumption', () => {
  it('should resume session when deviceId matches paired device', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    // 1. Initial pairing
    const pairCode = server.pairing.getCode();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode, deviceId: 'device-123' });
    expect(server.deviceCount).toBe(1);
    const firstPairConfirm = mockSocketEmit.mock.calls.find(
      ([event]) => event === SOCKET_EVENTS.PAIR_CONFIRM,
    )?.[1] as { authToken: string };

    // 2. Disconnect (should remain in Map but connected = false)
    triggerSocketEvent(SOCKET_EVENTS.DISCONNECT, 'transport close');
    expect(server.deviceCount).toBe(0);

    // 3. Reconnect with deviceId
    mockSocketEmit.mockClear();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, {
      deviceId: 'device-123',
      authToken: firstPairConfirm.authToken,
    });

    expect(server.deviceCount).toBe(1);
    expect(mockSocketEmit).toHaveBeenCalledWith(SOCKET_EVENTS.PAIR_CONFIRM, {
      deviceName: 'GHITA Desktop',
      deviceId: 'device-123',
      authToken: firstPairConfirm.authToken,
    });
  });

  it('should fail session resumption when deviceId is invalid', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    mockSocketEmit.mockClear();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { deviceId: 'nonexistent-id' });

    expect(server.deviceCount).toBe(0);
    expect(mockSocketEmit).toHaveBeenCalledWith(SOCKET_EVENTS.ERROR, {
      message: 'Session expired. Please re-pair.',
    });
  });

  it('should resume session when device connects with a new socket.id but same deviceId', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    // 1. Initial pairing on test-socket-1
    const pairCode = server.pairing.getCode();
    simulateConnection({ id: 'test-socket-1' });
    triggerSocketEvent(SOCKET_EVENTS.PAIR, { code: pairCode, deviceId: 'device-abc' });
    expect(server.deviceCount).toBe(1);
    const firstPairConfirm = mockSocketEmit.mock.calls.find(
      ([event]) => event === SOCKET_EVENTS.PAIR_CONFIRM,
    )?.[1] as { authToken: string };

    // 2. Disconnect
    triggerSocketEvent(SOCKET_EVENTS.DISCONNECT, 'ping timeout');
    expect(server.deviceCount).toBe(0);

    // 3. Connect a new socket test-socket-2 and resume session
    simulateConnection({ id: 'test-socket-2' });
    mockSocketEmit.mockClear();
    triggerSocketEvent(SOCKET_EVENTS.PAIR, {
      deviceId: 'device-abc',
      authToken: firstPairConfirm.authToken,
    });

    expect(server.deviceCount).toBe(1);
    expect(mockSocketEmit).toHaveBeenCalledWith(SOCKET_EVENTS.PAIR_CONFIRM, {
      deviceName: 'GHITA Desktop',
      deviceId: 'device-abc',
      authToken: firstPairConfirm.authToken,
    });
  });
});

describe('screenshot request authorization', () => {
  it('should reject screenshot requests from unpaired sockets', async () => {
    const server = createServer();

    const startPromise = server.start();
    const cb0 = mockIoListenCallback;
    if (cb0) cb0();
    await startPromise;

    mockSocketEmit.mockClear();
    triggerSocketEvent(SOCKET_EVENTS.SCREENSHOT);

    expect(mockSocketEmit).toHaveBeenCalledWith(SOCKET_EVENTS.ERROR, {
      message: 'Unauthorized: Device is not paired',
    });
  });
});
