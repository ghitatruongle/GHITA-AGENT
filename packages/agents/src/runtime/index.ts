// Barrel cho runtime modules (H2): event log, cursor, delta batcher,
// reconnect, confirmation, doom-loop, stop controller — dùng chung bởi
// sidecar (crew-handlers) và UI hooks sau này.
export { RunEventLog } from './event-log.js';
export type { SequencedEvent } from './event-log.js';
export { GapTolerantSeqCursor, MAX_AHEAD } from './cursor.js';
export { StreamingDeltaBatcher } from './delta-batcher.js';
export type { DeltaSlot } from './delta-batcher.js';
export { ReconnectPolicy } from './reconnect.js';
export type { ConnectionGracePhase, ReconnectDelay } from './reconnect.js';
export { ConfirmationGate } from './confirmation.js';
export type { PendingConfirmation } from './confirmation.js';
export { DoomLoopGate } from './doom-loop.js';
export type { DoomVerdict } from './doom-loop.js';
export { RunStopController } from './stop-controller.js';
export type { StopKind } from './stop-controller.js';
