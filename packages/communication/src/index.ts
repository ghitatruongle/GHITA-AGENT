// Desktop ↔ Mobile real-time communication via Socket.io

export { CommunicationServer } from './server.js';
export { PairingManager } from './pairing.js';
export { ScreenCapture } from './screen-capture.js';
export * from './types.js';

export { GatewayDaemon, getDefaultDaemon, resetDefaultDaemon, runDaemonCli } from './daemon.js';
export type {
  DaemonConfig,
  DaemonState,
  DaemonHealth,
  WorkerStatus,
  DaemonEventMap,
} from './daemon.js';

export { GuardrailPipeline, createDaemonGuardrailHook } from './guardrail-pipeline.js';
export type {
  GuardrailPipelineConfig,
  GuardrailPipelineResult,
  GuardrailThreat,
} from './guardrail-pipeline.js';

export * from './gateway/types.js';
export { TelegramGateway, startTelegramBot } from './gateway/telegram.js';
export { DiscordGateway, startDiscordBot } from './gateway/discord.js';
export { SlackGateway, startSlackBot } from './gateway/slack.js';
export type { SlackGatewayConfig } from './gateway/slack.js';
export { GatewayManager } from './gateway/manager.js';
export {
  MultiChannelGateway,
  type ChatChannelPlatform,
  type InboundChatMessage,
  type OutboundChatMessage,
} from './gateway/multi-channel-gateway.js';

export * from './channel-plugin-contract.js';

export { TelepresencePortal } from './channels/telepresencePortal.js';

export { TelegramAdapter } from './channels/telegram.js';
export { DiscordAdapter } from './channels/discord.js';
export { WhatsAppAdapter } from './channels/whatsapp.js';
export { IMessageAdapter } from './channels/imessage.js';
export { SlackAdapter } from './channels/slack.js';
export { isSafeUrl, safeFetch, getSessionKey } from './utils/security.js';

export { WsChannel, ReconnectStrategy, WsMultiplexer } from './ws/index.js';
export type {
  WsConnectionState,
  WsFrameType,
  ChannelMessage,
  ChannelSubscriptionOptions,
  ReconnectConfig,
  WsMultiplexerConfig,
  WsConnectionEvent,
  WsConnectionListener,
  ChannelHandler,
  BinaryFrameHeader,
  WsMuxStats,
} from './ws/index.js';

export const COMMUNICATION_VERSION = '0.0.0';
