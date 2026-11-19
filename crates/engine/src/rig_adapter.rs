//! RigAdapter — cầu nối rig-core 0.46 (v0.0.2-preview T5). Kiến trúc wire/
//! driver: config.from_env().client().chat|completion(model).call(req).
//! API key đọc từ env lúc gọi — không lưu key vào code.

use async_trait::async_trait;

use crate::client::CompletionRequest;
use crate::client::CompletionResponse;
use crate::client::EngineError;
use crate::client::ModelClient;

/// Adapter cho một provider rig ("openai" | "anthropic").
pub struct RigAdapter {
    provider: String,
}

impl RigAdapter {
    /// Trả Some chỉ khi provider được hỗ trợ VÀ API key đã có trong env.
    pub fn for_provider(provider: &str) -> Option<Self> {
        let ok = match provider {
            "openai" => std::env::var("OPENAI_API_KEY").is_ok_and(|v| !v.is_empty()),
            "anthropic" => std::env::var("ANTHROPIC_API_KEY").is_ok_and(|v| !v.is_empty()),
            _ => false,
        };
        if ok {
            Some(Self {
                provider: provider.to_string(),
            })
        } else {
            None
        }
    }
}

#[async_trait]
impl ModelClient for RigAdapter {
    async fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse, EngineError> {
        match self.provider.as_str() {
            "openai" => self.complete_openai(req).await,
            "anthropic" => self.complete_anthropic(req).await,
            _ => Err(EngineError::Config(format!(
                "unsupported provider: {}",
                self.provider
            ))),
        }
    }
}

fn to_engine_response(
    resp: rig_core::completion::CompletionResponse,
    provider: &str,
    model: &str,
) -> CompletionResponse {
    let text = resp
        .choice
        .iter()
        .filter_map(|c| match c {
            rig_core::completion::AssistantContent::Text(t) => Some(t.text().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    CompletionResponse {
        text,
        provider: provider.to_string(),
        model: model.to_string(),
        usage_in: resp.usage.input_tokens.unwrap_or(0),
        usage_out: resp.usage.output_tokens.unwrap_or(0),
    }
}

impl RigAdapter {
    async fn complete_openai(
        &self,
        req: &CompletionRequest,
    ) -> Result<CompletionResponse, EngineError> {
        let client = rig_core::providers::openai::OpenAIConfig::from_env()
            .map_err(|e| EngineError::Config(format!("openai env: {e:?}")))?
            .client();
        let model = client.chat(req.model.as_str());
        let resp = model
            .call(build_rig_request(req))
            .await
            .map_err(|e| EngineError::Provider(format!("{e}")))?;
        Ok(to_engine_response(resp, "openai", &req.model))
    }

    async fn complete_anthropic(
        &self,
        req: &CompletionRequest,
    ) -> Result<CompletionResponse, EngineError> {
        let client = rig_core::providers::anthropic::AnthropicConfig::from_env()
            .map_err(|e| EngineError::Config(format!("anthropic env: {e:?}")))?
            .client();
        let model = client.completion(req.model.as_str());
        let resp = model
            .call(build_rig_request(req))
            .await
            .map_err(|e| EngineError::Provider(format!("{e}")))?;
        Ok(to_engine_response(resp, "anthropic", &req.model))
    }
}

/// Map CompletionRequest → rig CompletionRequest (system → chat_history[0]).
fn build_rig_request(req: &CompletionRequest) -> rig_core::completion::CompletionRequest {
    let (preamble, body) = flatten_messages(req);
    let mut cr = rig_core::completion::CompletionRequest::new(body);
    if !preamble.is_empty() {
        cr.chat_history.insert(
            0,
            std::sync::Arc::new(rig_core::completion::Message::system(preamble)),
        );
    }
    cr.max_tokens = req.max_tokens.map(u64::from);
    cr
}

fn flatten_messages(req: &CompletionRequest) -> (String, String) {
    let mut preamble = String::new();
    let mut body = String::new();
    for m in &req.messages {
        if m.role == "system" {
            preamble.push_str(&m.content);
            preamble.push('\n');
        } else {
            body.push_str(&m.content);
            body.push('\n');
        }
    }
    (preamble.trim().to_string(), body.trim().to_string())
}
