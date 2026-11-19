# Lớp model Rust (v0.0.2-preview T5)

**Opt-in:** `GHITA_ENGINE=native` — mặc định TẮT; TS providers (@ghita/ai-engine)
vẫn là chính. Cấu trúc: crate `ghita-engine` — trait `ModelClient` (async-trait,
object-safe) + `RigAdapter` (rig-core 0.46.0, kiến trúc wire/driver:
`OpenAIConfig/AnthropicConfig::from_env().client().chat|completion(model)
.call(CompletionRequest)`) + napi `engineComplete` (JSON in/out, Promise) +
`tryNativeCompletion` (packages/ai-engine/src/rig-bridge.ts).

**Cắm điểm:** gateway `/v1/chat/completions` — flag on → native fast-path trước;
null/throw → orchestrator TS hiện có (fallback nguyên vẹn, 947 tests pass).

**v1 hạn chế:** completion đơn (không stream, không tool-calling) — backlog
chu kỳ sau. API key đọc từ env lúc gọi. e2e thật gated `GHITA_ENGINE_E2E=1`
(cần API key, không chạy CI).
