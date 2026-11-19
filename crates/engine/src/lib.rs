//! GHITA Rust-side model layer (v0.0.2-preview T5) — opt-in qua GHITA_ENGINE=native.
//! TS providers (@ghita/ai-engine) vẫn là chính; rig adapter là cầu nối.

#[cfg(feature = "addon")]
mod napi;

#[cfg(feature = "rig")]
pub mod rig_adapter;

pub mod client;

pub use client::CompletionMessage;
pub use client::CompletionRequest;
pub use client::CompletionResponse;
pub use client::EngineError;
pub use client::ModelClient;
pub use client::StubClient;
