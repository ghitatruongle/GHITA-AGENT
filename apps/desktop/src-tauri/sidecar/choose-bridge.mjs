// ==============================================================================
// Ghita Agent — Choose Bridge (v0.0.2-alpha integration, wires Track S3 P3)
// Sidecar ↔ desktop approval UI relay for the ai-engine `choose` tool.
// ==============================================================================
// The `choose` tool (@ghita/ai-engine, Track S3 P3) pauses the agent run and
// calls `globalThis.chooseRequestHandler`. This bridge relays the question to
// the trusted desktop UI over the existing require_approval /
// approve_command / reject_command vocabulary, and feeds the user's decision
// back into the engine via resolveChoose().
//
// Pattern parity with computer-use-bridge.mjs (Track S4):
//   - desktop-room-only emission — paired devices never see or answer
//     human-decision prompts (same rule as command approvals),
//   - strict payload whitelist before anything goes on the wire,
//   - id-guard: decisions only land on a pending choose request — the engine's
//     ToolApprovalManager returns false for unknown or already-decided ids,
//   - timeout stays owned by the engine (60s deny-default); the bridge adds no
//     second timer so a late answer can never resurrect a decided request.
// ==============================================================================

const MAX_ID_LENGTH = 200;
const MAX_QUESTION_LENGTH = 2_000;
const MIN_CHOOSE_OPTIONS = 2;
const MAX_CHOOSE_OPTIONS = 8;
const MAX_OPTION_LENGTH = 500;

/** Whitelist + validate a choose payload; null when it must not hit the wire. */
export function sanitizeChoosePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id || id.length > MAX_ID_LENGTH) return null;
  const question = typeof payload.question === 'string' ? payload.question : '';
  if (!question.trim() || question.length > MAX_QUESTION_LENGTH) return null;
  if (!Array.isArray(payload.options)) return null;
  const options = payload.options
    .map((option) => (typeof option === 'string' ? option : String(option ?? '')))
    .filter((option) => option.trim());
  if (
    options.length < MIN_CHOOSE_OPTIONS ||
    options.length > MAX_CHOOSE_OPTIONS ||
    options.some((option) => option.length > MAX_OPTION_LENGTH)
  ) {
    return null;
  }
  return {
    id,
    question,
    options,
    allowCustom: payload.allowCustom === true,
  };
}

/**
 * @param {object} deps
 * @param {(event: string, data: unknown) => void} deps.emitToDesktop
 *   Emit an event to the trusted desktop room only (sidecar emitToDesktop).
 * @param {(...args: unknown[]) => void} [deps.log]
 * @param {() => unknown} [deps.getEngine]
 *   Returns the already-loaded @ghita/ai-engine module namespace (or null when
 *   the engine has not been imported yet). Deliberately does NOT trigger a load:
 *   a choose request can only exist while the engine is running, so a decision
 *   arriving for an unloaded engine is stale and must be ignored.
 */
export function createChooseBridge({ emitToDesktop, log = () => {}, getEngine } = {}) {
  function resolveEngine() {
    const engine = typeof getEngine === 'function' ? getEngine() : null;
    if (engine && typeof engine.resolveChoose === 'function') return engine;
    return null;
  }

  /** Engine → UI: relay a pending choose question to the desktop room. */
  function handleRequest(payload) {
    const clean = sanitizeChoosePayload(payload);
    if (!clean) {
      log('[choose] Dropped malformed choose request payload.');
      return;
    }
    log(`[choose] Relaying "${clean.question}" (${clean.options.length} options) to desktop.`);
    emitToDesktop('require_approval', {
      id: clean.id,
      command: clean.question,
      options: clean.options,
      allowCustom: clean.allowCustom,
    });
  }

  /** UI → engine: approve_command handler. `choice` is the picked option text. */
  function approve(id, choice) {
    const engine = resolveEngine();
    if (!engine) return false;
    const picked = typeof choice === 'string' && choice.trim() ? choice : undefined;
    return engine.resolveChoose(id, true, picked);
  }

  /** UI → engine: reject_command handler. */
  function reject(id) {
    const engine = resolveEngine();
    if (!engine) return false;
    return engine.resolveChoose(id, false);
  }

  /** Register the engine-facing hook (same global-handler pattern as S3). */
  function install() {
    globalThis.chooseRequestHandler = handleRequest;
  }

  return { handleRequest, approve, reject, install };
}
