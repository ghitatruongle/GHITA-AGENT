//! ModelClient trait + types (v0.0.2-preview T5). Không lộ rig types ra napi —
//! contract = JSON string in/out (serde_json), cô lập churn upstream.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompletionRequest {
    /// "openai" | "anthropic"
    pub provider: String,
    pub model: String,
    pub messages: Vec<CompletionMessage>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompletionMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompletionResponse {
    pub text: String,
    pub provider: String,
    pub model: String,
    pub usage_in: u64,
    pub usage_out: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineError {
    Provider(String),
    Config(String),
    Json(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Provider(m) | EngineError::Config(m) | EngineError::Json(m) => {
                f.write_str(m)
            }
        }
    }
}

/// Abstract model client (object-safe qua async-trait — Box<dyn ModelClient>).
#[async_trait]
pub trait ModelClient: Send + Sync {
    async fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse, EngineError>;
}

/// Stub client cho tests + fallback khi rig feature tắt.
pub struct StubClient {
    pub text: String,
}

#[async_trait]
impl ModelClient for StubClient {
    async fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse, EngineError> {
        Ok(CompletionResponse {
            text: self.text.clone(),
            provider: req.provider.clone(),
            model: req.model.clone(),
            usage_in: 0,
            usage_out: 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stub_client_returns_fixed_text() {
        let c = StubClient { text: "ok".into() };
        let req = CompletionRequest {
            provider: "openai".into(),
            model: "gpt-test".into(),
            messages: vec![CompletionMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            max_tokens: None,
        };
        let r = c.complete(&req).await.unwrap();
        assert_eq!(r.text, "ok");
        assert_eq!(r.model, "gpt-test");
    }

    #[test]
    fn json_contract_roundtrip() {
        let req = CompletionRequest {
            provider: "anthropic".into(),
            model: "claude-test".into(),
            messages: vec![CompletionMessage {
                role: "user".into(),
                content: "x".into(),
            }],
            max_tokens: Some(128),
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: CompletionRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back, req);
    }
}
