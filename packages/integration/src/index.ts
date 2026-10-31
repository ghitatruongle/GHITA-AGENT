// @ghita/integration -- Public API

export { GhitaCore } from './core.js';
export { EventBus } from './event-bus.js';
export { ServiceRegistry } from './service-registry.js';
export { HealthCheckAggregator } from './health-check.js';
export type { ServiceHealth, EventHandler, ServiceDefinition } from './types.js';

export const INTEGRATION_VERSION = '0.0.0';
