export { ErrorMonitor } from './error-monitor.js';
export type { ErrorMonitorEvents } from './error-monitor.js';
export { SentryClient } from './sentry-client.js';
export type { SentryBreadcrumb } from './sentry-client.js';
export { ErrorGrouper } from './error-grouper.js';
export type { ErrorGrouperOptions } from './error-grouper.js';
export { Tracer } from './performance-tracer.js';
export type { TracerOptions } from './performance-tracer.js';
export { AlertEngine } from './alert-rules.js';
export { UsageTelemetry, getTelemetry, initTelemetry } from './telemetry.js';
export type { TelemetryEvent, TelemetryConfig } from './telemetry.js';

export type {
  Severity,
  MonitoringContext,
  SentryConfig,
  PerformanceSpan,
  PerformanceTransaction,
  AlertRule,
  AlertEvent,
  ErrorGroup,
  CapturedError,
  MonitoringConfig,
  MonitoringStats,
} from './types.js';

export const MONITORING_VERSION = '0.0.0-preview';
