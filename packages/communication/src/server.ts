// Socket.io server for Desktop ↔ Mobile real-time communication

import { createServer, type Server as HttpServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { networkInterfaces, hostname, homedir, tmpdir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SOCKET_EVENTS, generateId } from '@ghita/shared';
import type { DeviceInfo } from '@ghita/shared';
import { PairingManager } from './pairing.js';
import { ScreenCapture, type ScreenCaptureOptions } from './screen-capture.js';
import type { ServerConfig, ServerEvents, PairedDevice, CommandPayload } from './types.js';
import { ChannelPluginRegistry } from './channel-plugin-contract.js';

function secureStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const DEFAULT_PAIRED_DEVICES_FILE = path.resolve(homedir(), '.ghita-paired-devices.json');

function normalizeAddress(address = ''): string {
  return address
    .replace(/^::ffff:/, '')
    .replace(/^\[|\]$/g, '')
    .trim()
    .toLowerCase();
}

function isLoopbackAddress(address = ''): boolean {
  const normalized = normalizeAddress(address);
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function isAllowedLocalOrigin(origin?: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', 'tauri.localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}

function isLanOrigin(origin?: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    // Allow LAN: 192.168.x.x, 10.x.x.x, 172.16-31.x.x
    return /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(hostname);
  } catch {
    return false;
  }
}

const DEFAULT_CONFIG: ServerConfig = {
  port: 8080,
  host: '0.0.0.0',
  cors: {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      // Allow localhost and LAN addresses
      if (isAllowedLocalOrigin(origin) || isLanOrigin(origin)) {
        return callback(null, true);
      }
      callback(new Error('CORS not allowed'));
    },
    methods: ['GET', 'POST'],
  },
};

export class CommunicationServer {
  private httpServer: HttpServer | null = null;
  private io: SocketIOServer | null = null;
  private config: ServerConfig;
  private events: ServerEvents = {};
  private connectedDevices = new Map<string, PairedDevice>();
  private pairedDevicesFile: string;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  readonly channelRegistry = new ChannelPluginRegistry();

  private loadPairedDevices(): void {
    try {
      if (fs.existsSync(this.pairedDevicesFile)) {
        const data = fs.readFileSync(this.pairedDevicesFile, 'utf8');
        const list = JSON.parse(data);
        if (Array.isArray(list)) {
          for (const d of list) {
            if (d.id && d.name) {
              this.connectedDevices.set(d.id, {
                id: d.id,
                name: d.name,
                platform: d.platform || 'android',
                connected: false,
                lastSeen: d.lastSeen || Date.now(),
                socketId: '',
                pairedAt: d.pairedAt || Date.now(),
                secret: typeof d.secret === 'string' ? d.secret : null,
              });
            }
          }
          console.info(
            `[CommServer] Loaded ${list.length} paired devices from persistent storage.`,
          );
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[CommServer] Failed to load persistent paired devices: ${message}`);
    }
  }

  private savePairedDevices(): void {
    try {
      const list = Array.from(this.connectedDevices.values())
        .filter((d) => d.id && d.id !== 'cloud_session') 
        .map((d) => ({
          id: d.id,
          name: d.name,
          platform: d.platform,
          pairedAt: d.pairedAt,
          lastSeen: d.lastSeen,
          secret: d.secret,
        }));
      fs.writeFileSync(this.pairedDevicesFile, JSON.stringify(list, null, 2), 'utf8');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[CommServer] Failed to save paired devices: ${message}`);
    }
  }

  readonly pairing: PairingManager;
  readonly screenCapture: ScreenCapture;

  constructor(config: Partial<ServerConfig> = {}, options?: ScreenCaptureOptions) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pairedDevicesFile =
      this.config.pairedDevicesFile ||
      (process.env.NODE_ENV === 'test'
        ? path.resolve(tmpdir(), `.ghita-paired-devices-test-${generateId()}.json`)
        : DEFAULT_PAIRED_DEVICES_FILE);
    this.pairing = new PairingManager();
    this.screenCapture = new ScreenCapture({}, options);
  }

  // Lifecycle
  
  /**
   * Start the Socket.io server
   */
  async start(): Promise<void> {
    if (this.io) {
      console.warn('[CommServer] Server already running');
      return;
    }

    this.loadPairedDevices();

    const getLocalIP = (): string => {
      const interfaces = networkInterfaces();
      const entries = Object.entries(interfaces);

      // Sort entries so physical interfaces (Wi-Fi, Ethernet) come first
      entries.sort(([nameA], [nameB]) => {
        const a = nameA.toLowerCase();
        const b = nameB.toLowerCase();

        const isVirtual = (name: string) =>
          name.includes('vethernet') ||
          name.includes('wsl') ||
          name.includes('docker') ||
          name.includes('vmnet') ||
          name.includes('vbox') ||
          name.includes('virtualbox') ||
          name.includes('vpn') ||
          name.includes('host-only') ||
          name.includes('loopback');

        const isPhysical = (name: string) =>
          name.includes('wi-fi') ||
          name.includes('wifi') ||
          name.includes('wlan') ||
          name.includes('ethernet') ||
          name.includes('eth') ||
          name.includes('en');

        const vA = isVirtual(a);
        const vB = isVirtual(b);
        const pA = isPhysical(a);
        const pB = isPhysical(b);

        if (vA && !vB) return 1;
        if (!vA && vB) return -1;
        if (pA && !pB) return -1;
        if (!pA && pB) return 1;
        return 0;
      });

      for (const [, addrs] of entries) {
        if (!addrs) continue;
        for (const addr of addrs) {
          const family = addr.family as string | number;
          const isIPv4 = family === 'IPv4' || family === 4;
          if (isIPv4 && !addr.internal) {
            return addr.address;
          }
        }
      }
      return '127.0.0.1';
    };

    const getSanitizedHostname = (): string => {
      return hostname()
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '');
    };

    this.httpServer = createServer((req, res) => {
      const isLoopback = isLoopbackAddress(req.socket.remoteAddress || '');
      const origin = req.headers.origin;
      if (isAllowedLocalOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || 'http://localhost');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Route channel webhooks (Tauri HTTP server mount channels)
      const channelWebhookMatch = req.url
        ? req.url.match(/^\/channels\/([^/]+)\/adapters\/([^/]+)\/webhook/)
        : null;
      if (channelWebhookMatch) {
        const channelId = channelWebhookMatch[1] || '';
        const adapterId = channelWebhookMatch[2] || '';
        const channel = this.channelRegistry.getChannel(channelId);
        if (channel) {
          const adapter = channel.adapters[adapterId];
          if (adapter && typeof adapter.handleWebhook === 'function') {
            const handleWebhook = adapter.handleWebhook;
            let body = '';
            const MAX_WEBHOOK_BODY = 1024 * 1024; // 1 MB limit
            let bodyOverflow = false;
            req.on('data', (chunk: Buffer | string) => {
              if (bodyOverflow) return;
              body += chunk;
              if (body.length > MAX_WEBHOOK_BODY) {
                bodyOverflow = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Webhook payload too large (max 1MB)' }));
              }
            });
            req.on('end', () => {
              if (bodyOverflow) return;
              try {
                const parsedBody = body ? JSON.parse(body) : {};
                const mockReq = {
                  headers: req.headers,
                  method: req.method,
                  url: req.url,
                  body: parsedBody,
                  rawBody: body,
                };
                const mockRes = {
                  writeHead: (status: number, headers?: Record<string, string | string[]>) => {
                    res.writeHead(status, headers);
                  },
                  end: (data: unknown) => {
                    res.end(data as string | Uint8Array);
                  },
                  status: (code: number) => {
                    res.statusCode = code;
                    return mockRes;
                  },
                  json: (jsonObj: unknown) => {
                    res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(jsonObj));
                  },
                };
                void handleWebhook(mockReq, mockRes);
              } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid webhook request payload' }));
              }
            });
            return;
          }
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `Webhook endpoint for channel "${channelId}" adapter "${adapterId}" not found.`,
          }),
        );
        return;
      }

      if (req.url === '/health') {
        const state = this.pairing.getState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            connectedDevices: this.deviceCount,
            uptime: process.uptime(),
            localIP: getLocalIP(),
            port: this.config.port,
            ...(isLoopback
              ? { pairingCode: this.pairing.getCode(), codeExpiresAt: state.expiresAt }
              : {}),
            hostname: getSanitizedHostname(),
            ...(isLoopback ? { devices: this.getConnectedDevices() } : {}),
          }),
        );
        return;
      }

      if (req.url === '/pair') {
        if (!isLoopback) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'Pairing code is only available from the desktop app.' }),
          );
          return;
        }

        const state = this.pairing.getState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            code: this.pairing.getCode(),
            expiresAt: state.expiresAt,
            port: this.config.port,
            localIP: getLocalIP(),
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        ...this.config.cors,
        origin: (
          origin: string | undefined,
          callback: (err: Error | null, allow?: boolean) => void,
        ) => {
          if (isAllowedLocalOrigin(origin)) {
            callback(null, true);
            return;
          }
          callback(new Error('Origin is not allowed by GHITA communication server CORS policy'));
        },
      },
      transports: ['websocket', 'polling'],
      pingInterval: 5000,
      pingTimeout: 3000,
    });

    this.registerSocketHandlers();

    // Start pairing auto-refresh
    this.pairing.startAutoRefresh((newCode) => {
      console.info(`[CommServer] Pairing code refreshed: ${newCode}`);
    });

    return new Promise<void>((resolve, reject) => {
      if (!this.httpServer) return reject(new Error('HTTP server not initialized'));

      this.httpServer.on('error', (err) => {
        console.error('[CommServer] Server error:', err.message);
        this.events.onError?.(err);
        reject(err);
      });

      this.httpServer.listen(this.config.port, this.config.host, () => {
        console.info(
          `[CommServer] 🚀 Socket.io server listening on ${this.config.host}:${this.config.port}`,
        );
        console.info(`[CommServer] 🔑 Pairing code: ${this.pairing.getCode()}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    this.disableGlobalCommandApproval();
    this.screenCapture.dispose();
    this.pairing.dispose();

    if (process.env.NODE_ENV === 'test' && fs.existsSync(this.pairedDevicesFile)) {
      try {
        fs.unlinkSync(this.pairedDevicesFile);
      } catch {}
    }

    // Disconnect all clients
    if (this.io) {
      this.io.disconnectSockets(true);
      this.io.close();
      this.io = null;
    }

    if (this.httpServer) {
      const server = this.httpServer;
      await new Promise<void>((resolve) => {
        server.close(() => {
          console.info('[CommServer] Server stopped');
          this.httpServer = null;
          resolve();
        });
      });
    }

    this.connectedDevices.clear();
  }

  /**
   * Enable global terminal command approval handler linked to remote devices
   */
  enableGlobalCommandApproval(): void {
    (globalThis as Record<string, unknown>).approveCommandHandler = async (
      command: string,
    ): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const id = `approve_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        this.pendingApprovals.set(id, resolve);

        // Auto-reject after 5 minutes to prevent memory leak
        const timeout = setTimeout(
          () => {
            if (this.pendingApprovals.has(id)) {
              this.pendingApprovals.delete(id);
              resolve(false);
            }
          },
          5 * 60 * 1000,
        );

        const wrappedResolve = (value: boolean) => {
          clearTimeout(timeout);
          resolve(value);
        };
        this.pendingApprovals.set(id, wrappedResolve);

        this.broadcastRequireApproval({
          id,
          command,
          timestamp: Date.now(),
        });
      });
    };

    // Link events to resolve pending approvals
    this.events.onApproveCommand = (_deviceId, data) => {
      const resolve = this.pendingApprovals.get(data.id);
      if (resolve) {
        resolve(true);
        this.pendingApprovals.delete(data.id);
      }
    };

    this.events.onRejectCommand = (_deviceId, data) => {
      const resolve = this.pendingApprovals.get(data.id);
      if (resolve) {
        resolve(false);
        this.pendingApprovals.delete(data.id);
      }
    };
  }

  /**
   * Disable the global terminal command approval handler
   */
  disableGlobalCommandApproval(): void {
    (globalThis as Record<string, unknown>).approveCommandHandler = null;
    this.pendingApprovals.clear();
  }

  // Public API
  
  /**
   * Register event callbacks
   */
  setCallbacks(events: ServerEvents): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * Get list of connected devices
   */
  getConnectedDevices(): DeviceInfo[] {
    return [...this.connectedDevices.values()].map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      connected: d.connected,
      lastSeen: d.lastSeen,
    }));
  }

  /**
   * Get number of connected devices
   */
  get deviceCount(): number {
    return [...this.connectedDevices.values()].filter((d) => d.connected).length;
  }

  /**
   * Check if server is running
   */
  get isRunning(): boolean {
    return this.io !== null;
  }

  /**
   * Get server address info
   */
  getAddress(): { host: string; port: number } {
    return { host: this.config.host ?? '0.0.0.0', port: this.config.port };
  }

  /**
   * Send a screenshot to all connected devices
   */
  async broadcastScreenshot(): Promise<void> {
    if (!this.io || this.deviceCount === 0) return;

    try {
      const imageBase64 = await this.screenCapture.captureScreen();
      this.io.to('paired-devices').emit(SOCKET_EVENTS.SCREEN_STREAM, {
        image: imageBase64,
        timestamp: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[CommServer] Screenshot broadcast failed:', message);
    }
  }

  /**
   * Send a chat message to all connected devices
   */
  broadcastChat(text: string): void {
    if (!this.io) return;
    this.io.to('paired-devices').emit(SOCKET_EVENTS.CHAT, {
      text,
      timestamp: Date.now(),
    });
  }

  /**
   * Send status update to all connected devices
   */
  broadcastStatus(status: Record<string, unknown>): void {
    if (!this.io) return;
    this.io.to('paired-devices').emit(SOCKET_EVENTS.STATUS, status);
  }

  /**
   * Send generic broadcast to all connected devices
   */
  broadcast(event: string, data: unknown): void {
    if (!this.io) return;
    this.io.to('paired-devices').emit(event, data);
  }

  /**
   * Broadcast real-time AI cost telemetry
   */
  broadcastCostTelemetry(data: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd: number;
    limitUsd: number;
  }): void {
    if (!this.io) return;
    this.io.to('paired-devices').emit(SOCKET_EVENTS.COST_TELEMETRY, data);
  }

  /**
   * Broadcast terminal command approval requirement
   */
  broadcastRequireApproval(data: { id: string; command: string; timestamp: number }): void {
    if (!this.io) return;
    this.io.to('paired-devices').emit(SOCKET_EVENTS.REQUIRE_APPROVAL, data);
  }

  // Socket Event Handlers
  
  private registerSocketHandlers(): void {
    if (!this.io) return;

    this.io.on('connection', (socket: Socket) => {
      console.info(`[CommServer] New connection: ${socket.id}`);

      // C7: Validate auth token from handshake for reconnecting devices
      const handshakeAuth = socket.handshake?.auth as { token?: string } | undefined;
      if (handshakeAuth?.token) {
        const existingDevice = this.findDeviceByToken(handshakeAuth.token);
        if (existingDevice) {
          existingDevice.socketId = socket.id;
          existingDevice.lastSeen = Date.now();
          
          // reconnecting device actually receives broadcasts (chat, status,
          // screenshot, approvals). Previously the socketId was updated but
          // the room membership was never granted, leaving the device
          // "connected" yet blind to every broadcast until a full re-pair.
          void socket.join('paired-devices');
          socket.emit(SOCKET_EVENTS.PAIR_CONFIRM, { deviceName: 'GHITA Desktop' });
          console.info(`[CommServer] Device ${existingDevice.name} reconnected via token`);
        }
      }

      // --- Pairing ---
      socket.on(
        SOCKET_EVENTS.PAIR,
        (data: { code?: string; deviceId?: string; authToken?: string; timestamp?: number }) => {
          this.handlePairing(socket, data);
        },
      );

      // --- Commands ---
      socket.on(SOCKET_EVENTS.COMMAND, (data: CommandPayload) => {
        const device = this.findDeviceBySocket(socket.id);
        if (device) {
          device.lastSeen = Date.now();
          this.events.onCommand?.(device.id, data);
        }
      });

      // --- Chat ---
      socket.on(SOCKET_EVENTS.CHAT, (data: { text?: string }) => {
        const device = this.findDeviceBySocket(socket.id);
        if (device && data.text) {
          device.lastSeen = Date.now();
          // C17: Emit chat_start before forwarding to AI
          socket.emit('chat_start', { timestamp: Date.now() });
          this.events.onChat?.(device.id, data.text);
        }
      });

      // --- Screenshot Request ---
      socket.on(SOCKET_EVENTS.SCREENSHOT, () => {
        const device = this.findDeviceBySocket(socket.id);
        if (device) {
          void this.handleScreenshotRequest(socket);
        } else {
          socket.emit(SOCKET_EVENTS.ERROR, { message: 'Unauthorized: Device is not paired' });
        }
      });

      // --- Approve / Reject ---
      socket.on(SOCKET_EVENTS.APPROVE, () => {
        const device = this.findDeviceBySocket(socket.id);
        if (device) {
          device.lastSeen = Date.now();
          this.events.onApprove?.(device.id);
        }
      });

      socket.on(SOCKET_EVENTS.REJECT, () => {
        const device = this.findDeviceBySocket(socket.id);
        if (device) {
          device.lastSeen = Date.now();
          this.events.onReject?.(device.id);
        }
      });

      socket.on(SOCKET_EVENTS.APPROVE_COMMAND, (data: { id: string }) => {
        const device = this.findDeviceBySocket(socket.id);
        if (device && data?.id) {
          device.lastSeen = Date.now();
          this.events.onApproveCommand?.(device.id, data);
        }
      });

      socket.on(SOCKET_EVENTS.REJECT_COMMAND, (data: { id: string }) => {
        const device = this.findDeviceBySocket(socket.id);
        if (device && data?.id) {
          device.lastSeen = Date.now();
          this.events.onRejectCommand?.(device.id, data);
        }
      });

      // --- Ping/Pong (keepalive) ---
      socket.on(SOCKET_EVENTS.PONG, () => {
        const device = this.findDeviceBySocket(socket.id);
        if (device) {
          device.lastSeen = Date.now();
        }
      });

      socket.on(
        'mcp_tool_call',
        (data: { serverName: string; toolName: string; args: Record<string, unknown> }) => {
          const device = this.findDeviceBySocket(socket.id);
          if (!device) {
            socket.emit(SOCKET_EVENTS.ERROR, { message: 'Unauthorized: Device is not paired' });
            return;
          }
          device.lastSeen = Date.now();
          console.info(`[CommServer] MCP tool call: ${data.toolName} on ${data.serverName}`);
          // Forward to event handler — orchestrator will handle actual MCP call
          this.events.onChat?.(device.id, JSON.stringify({ type: 'mcp_tool_call', ...data }));
        },
      );

      socket.on('web_search', (data: { query: string; maxResults?: number }) => {
        const device = this.findDeviceBySocket(socket.id);
        if (!device) {
          socket.emit(SOCKET_EVENTS.ERROR, { message: 'Unauthorized: Device is not paired' });
          return;
        }
        device.lastSeen = Date.now();
        console.info(`[CommServer] Web search: ${data.query}`);
        this.events.onChat?.(device.id, JSON.stringify({ type: 'web_search', ...data }));
      });

      socket.on('image_input', (data: { image: string; prompt?: string }) => {
        const device = this.findDeviceBySocket(socket.id);
        if (!device) {
          socket.emit(SOCKET_EVENTS.ERROR, { message: 'Unauthorized: Device is not paired' });
          return;
        }
        device.lastSeen = Date.now();
        console.info(`[CommServer] Image input received`);
        this.events.onChat?.(device.id, JSON.stringify({ type: 'image_input', ...data }));
      });

      // --- Sync Language ---
      socket.on(SOCKET_EVENTS.SYNC_LANGUAGE, (data: { language: string }) => {
        console.info(`[CommServer] Sync language received: ${data.language}`);
        socket.broadcast.emit(SOCKET_EVENTS.SYNC_LANGUAGE, data);
      });

      socket.on('set_workspace', (data: { workspacePath: string }) => {
        const device = this.findDeviceBySocket(socket.id);
        if (!device) {
          socket.emit(SOCKET_EVENTS.ERROR, { message: 'Unauthorized: Device is not paired' });
          return;
        }
        if (data?.workspacePath) {
          device.lastSeen = Date.now();
          console.info(
            `[CommServer] Workspace set for device ${device.name}: ${data.workspacePath}`,
          );
          this.events.onCommand?.(device.id, { action: 'set_workspace', path: data.workspacePath });
        }
      });

      socket.on('set_skill_enabled', (data: { skillId: string; enabled: boolean }) => {
        const device = this.findDeviceBySocket(socket.id);
        if (!device) {
          socket.emit(SOCKET_EVENTS.ERROR, { message: 'Unauthorized: Device is not paired' });
          return;
        }
        if (data?.skillId !== undefined) {
          device.lastSeen = Date.now();
          console.info(
            `[CommServer] Skill ${data.skillId} ${data.enabled ? 'enabled' : 'disabled'} by ${device.name}`,
          );
          this.events.onCommand?.(device.id, {
            action: 'set_skill_enabled',
            skillId: data.skillId,
            enabled: data.enabled,
          });
        }
      });

      socket.on('run_skill', (data: { skillId: string; params?: Record<string, unknown> }) => {
        const device = this.findDeviceBySocket(socket.id);
        if (!device) {
          socket.emit(SOCKET_EVENTS.ERROR, { message: 'Unauthorized: Device is not paired' });
          return;
        }
        if (data?.skillId) {
          device.lastSeen = Date.now();
          console.info(`[CommServer] Run skill ${data.skillId} by ${device.name}`);
          this.events.onCommand?.(device.id, {
            action: 'run_skill',
            skillId: data.skillId,
            params: data.params,
          });
        }
      });

      socket.on('list_skills', () => {
        const device = this.findDeviceBySocket(socket.id);
        if (!device) {
          socket.emit(SOCKET_EVENTS.ERROR, { message: 'Unauthorized: Device is not paired' });
          return;
        }
        device.lastSeen = Date.now();
        console.info(`[CommServer] List skills requested by ${device.name}`);
        this.events.onCommand?.(device.id, { action: 'list_skills', timestamp: Date.now() });
      });

      // --- Disconnect ---
      socket.on(SOCKET_EVENTS.DISCONNECT, (reason: string) => {
        const device = this.findDeviceBySocket(socket.id);
        if (device) {
          console.info(`[CommServer] Device disconnected: ${device.name} (${reason})`);
          device.connected = false;
          this.events.onDeviceDisconnected?.(device.id);
        }
      });
    });
  }

  private handlePairing(
    socket: Socket,
    data: { code?: string; deviceId?: string; authToken?: string; timestamp?: number },
  ): void {
    const code = data.code?.toUpperCase();
    const deviceId = data.deviceId;
    const authToken = data.authToken;

    if (!code && !deviceId) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: 'Pairing code or device ID is required' });
      return;
    }

    let device: PairedDevice | undefined;

    if (code) {
      if (!this.pairing.validate(code)) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid or expired pairing code' });
        return;
      }

      // Create paired device using client's deviceId (or generate if not provided)
      const dId = data.deviceId || generateId('device');
      device = {
        id: dId,
        name: `Mobile-${socket.id.slice(0, 6)}`,
        platform: 'android',
        connected: true,
        lastSeen: Date.now(),
        socketId: socket.id,
        pairedAt: Date.now(),
        secret: randomBytes(32).toString('hex'),
      };
      this.connectedDevices.set(device.id, device);
      this.savePairedDevices();

      // Generate new pairing code after successful pair (security)
      this.pairing.regenerate();
      console.info(`[CommServer] ✅ Device paired: ${device.name} (${device.id})`);
    } else if (deviceId) {
      // Session Resumption / Reconnection
      device = this.connectedDevices.get(deviceId);
      
      // comparison — the previous `authToken === device.secret` leaked timing
      // information that could help brute-force a session token.
      if (device && device.secret && authToken && secureStringEqual(authToken, device.secret)) {
        // Device is already paired on this server session!
        if (device.socketId && device.socketId !== socket.id) {
          const oldSocket = this.io?.sockets?.sockets?.get(device.socketId);
          if (oldSocket) {
            console.info(
              `[CommServer] Disconnecting old socket ${device.socketId} for device ${device.id}`,
            );
            oldSocket.disconnect(true);
          }
        }
        device.socketId = socket.id;
        device.connected = true;
        device.lastSeen = Date.now();
        console.info(`[CommServer] 🔄 Session resumed for device: ${device.name} (${device.id})`);
      } else {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Session expired. Please re-pair.' });
        return;
      }
    }

    if (device) {
      // Join the paired-devices room
      void socket.join('paired-devices');

      // Confirm pairing to mobile
      socket.emit(SOCKET_EVENTS.PAIR_CONFIRM, {
        deviceName: 'GHITA Desktop',
        deviceId: device.id,
        authToken: device.secret,
      });

      this.events.onDeviceConnected?.(device);
    }
  }

  private async handleScreenshotRequest(socket: Socket): Promise<void> {
    try {
      const imageBase64 = await this.screenCapture.captureScreen();
      socket.emit(SOCKET_EVENTS.SCREEN_STREAM, {
        image: imageBase64,
        timestamp: Date.now(),
      });
    } catch {
      socket.emit(SOCKET_EVENTS.ERROR, {
        message: 'Failed to capture screenshot',
      });
    }
  }

  private findDeviceBySocket(socketId: string): PairedDevice | undefined {
    for (const device of this.connectedDevices.values()) {
      if (device.socketId === socketId) {
        return device;
      }
    }
    return undefined;
  }

  /** C7: Find paired device by auth token (secret) for reconnect validation */
  private findDeviceByToken(token: string): PairedDevice | undefined {
    for (const device of this.connectedDevices.values()) {
      if (device.secret === token) {
        return device;
      }
    }
    return undefined;
  }
}
