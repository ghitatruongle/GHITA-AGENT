// @ghita/migration -- Public API

export { MigrationRunner } from './runner.js';
export { MigrationRegistry } from './registry.js';
export { compareVersions, isValidVersion } from './version-detector.js';
export type { Migration, MigrationState, MigrationRunnerConfig } from './types.js';

export const MIGRATION_VERSION = '0.0.0-preview';
