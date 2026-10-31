// --- Types ---
export type {
  NotificationPriority,
  NotificationChannel,
  NotificationStatus,
  Notification,
  ChannelPreference,
  NotificationPreferences,
  DndSchedule,
  ChannelDelivery,
  NotificationListener,
} from './types.js';

// --- Modules ---
export { PriorityRouter } from './priority.js';
export { ChannelRouter, InMemorySink, TauriNotificationSink } from './channel.js';
export type { NotificationSink } from './channel.js';
export { DndScheduler } from './dnd.js';
export { NotificationHistory } from './history.js';
export { BatchDeliveryService } from './batch.js';
export type { BatchConfig, BatchFlushListener } from './batch.js';
export { NotificationTemplate } from './template.js';
export type { TemplateContext, TemplateOptions } from './template.js';

export const NOTIFICATION_VERSION = '0.0.0';
