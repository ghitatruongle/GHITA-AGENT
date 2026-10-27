//! Ghita Agent — Tokenizer NAPI addon
//! Exposes exact BPE token counting to Node.js via @ghita/native-bridge.
//! Compiled only with --features addon. Uses dyn-symbols for Windows compat.
#![expect(dead_code)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{count_messages_tokens, count_tokens, EncodingFamily};

fn parse_family(family: Option<String>) -> EncodingFamily {
    match family.as_deref() {
        Some("o200k") => EncodingFamily::O200k,
        Some("cl100k") => EncodingFamily::Cl100k,
        Some("r50k") => EncodingFamily::R50k,
        _ => EncodingFamily::Cl100k,
    }
}

/// Count tokens for a single text string.
/// family: "o200k" | "cl100k" | "r50k" (default "cl100k")
#[napi]
pub fn count_tokens_js(text: String, family: Option<String>) -> Result<u32> {
    let f = parse_family(family);
    count_tokens(&text, f)
        .map(|n| n as u32)
        .map_err(|e| Error::from_reason(e))
}

/// Count tokens for a list of [role, content] message pairs.
/// Includes per-message overhead (~4 tokens) and reply priming (+2).
#[napi]
pub fn count_messages_tokens_js(messages: Vec<MessagePair>, family: Option<String>) -> Result<u32> {
    let f = parse_family(family);
    let pairs: Vec<(&str, &str)> = messages
        .iter()
        .map(|m| (m.role.as_str(), m.content.as_str()))
        .collect();
    count_messages_tokens(&pairs, f)
        .map(|n| n as u32)
        .map_err(|e| Error::from_reason(e))
}

/// Detect the best encoding family from a model name string.
#[napi]
pub fn detect_encoding_family(model: String) -> String {
    match EncodingFamily::from_model(&model) {
        EncodingFamily::O200k => "o200k".to_string(),
        EncodingFamily::Cl100k => "cl100k".to_string(),
        EncodingFamily::R50k => "r50k".to_string(),
    }
}

#[napi(object)]
pub struct MessagePair {
    pub role: String,
    pub content: String,
}
