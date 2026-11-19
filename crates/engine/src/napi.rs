//! ghita-engine napi surface — JSON string in/out (cô lập upstream churn).
#![expect(dead_code)]

use napi::bindgen_prelude::*;

use napi_derive::napi;

use crate::client::CompletionRequest;

/// Hoàn tất một lượt: parse JSON payload → ModelClient → JSON response.
/// Chọn adapter theo `provider` field. Fallback Task trait nếu napi async
/// có vấn đề — hiện dùng napi async fn (Promise) với feature "async".
#[napi]
pub async fn engine_complete(payload: String) -> Result<String> {
    let req: CompletionRequest = serde_json::from_str(&payload)
        .map_err(|e| Error::new(Status::GenericFailure, format!("bad payload: {e}")))?;
    let client = make_client(&req.provider)?;
    let resp = client
        .complete(&req)
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    serde_json::to_string(&resp)
        .map_err(|e| Error::new(Status::GenericFailure, format!("encode: {e}")))
}

fn make_client(provider: &str) -> Result<std::sync::Arc<dyn crate::ModelClient>> {
    #[cfg(feature = "rig")]
    {
        if let Some(c) = crate::rig_adapter::RigAdapter::for_provider(provider) {
            return Ok(std::sync::Arc::new(c) as std::sync::Arc<dyn crate::ModelClient>);
        }
        Err(Error::new(
            Status::GenericFailure,
            format!("unknown provider: {provider} (openai|anthropic)"),
        ))
    }
    #[cfg(not(feature = "rig"))]
    {
        let _ = provider;
        Err(Error::new(
            Status::GenericFailure,
            "rig feature not enabled in this build",
        ))
    }
}

/// Ping — addon availability probe cho TS bridge.
#[napi]
pub fn engine_available() -> bool {
    true
}
