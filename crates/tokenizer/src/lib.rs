//! Ghita Agent — Exact BPE Token Counter & Cached Estimator
//! Wraps tiktoken-rs to provide exact token counts for OpenAI/Claude/GPT models.
//! Features:
//! 1. Exact BPE token counting across o200k, cl100k, r50k encodings.
//! 2. Rolling hash cache for repetitive tokens (System Prompts, Operator Charters).
//! 3. Message structure overhead calculation.

#[cfg(feature = "addon")]
mod napi;

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

/// Supported encoding families. Maps to tiktoken-rs BPE vocabularies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EncodingFamily {
    /// GPT-4o / o1 / o3 family (o200k_base)
    O200k,
    /// GPT-4 / GPT-3.5-turbo / Claude (cl100k_base)
    Cl100k,
    /// Legacy GPT-3 (r50k_base)
    R50k,
}

impl EncodingFamily {
    /// Parse from a model name string. Returns the best-matching encoding.
    pub fn from_model(model: &str) -> Self {
        let lower = model.to_lowercase();
        if lower.contains("gpt-4o") || lower.contains("o1") || lower.contains("o3") {
            EncodingFamily::O200k
        } else if lower.contains("r50k") || lower.contains("davinci") {
            EncodingFamily::R50k
        } else {
            EncodingFamily::Cl100k // safe default for gpt-4, gpt-3.5, claude, deepseek etc.
        }
    }
}

/// Simple thread-safe token cache keyed by a fast 64-bit hash of (family, text).
pub struct TokenCache {
    cache: RwLock<HashMap<(EncodingFamily, u64), usize>>,
    max_entries: usize,
}

impl TokenCache {
    pub fn new(max_entries: usize) -> Self {
        TokenCache {
            cache: RwLock::new(HashMap::new()),
            max_entries,
        }
    }

    fn hash_key(family: EncodingFamily, text: &str) -> (EncodingFamily, u64) {
        // FNV-1a 64-bit hash
        let mut hash = 0xcbf29ce484222325u64;
        for b in text.as_bytes() {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        (family, hash)
    }

    pub fn get(&self, family: EncodingFamily, text: &str) -> Option<usize> {
        let key = Self::hash_key(family, text);
        if let Ok(read_guard) = self.cache.read() {
            read_guard.get(&key).copied()
        } else {
            None
        }
    }

    pub fn insert(&self, family: EncodingFamily, text: &str, count: usize) {
        let key = Self::hash_key(family, text);
        if let Ok(mut write_guard) = self.cache.write() {
            if write_guard.len() >= self.max_entries {
                write_guard.clear(); // simple eviction on overflow
            }
            write_guard.insert(key, count);
        }
    }
}

pub fn global_token_cache() -> &'static TokenCache {
    static CACHE: OnceLock<TokenCache> = OnceLock::new();
    CACHE.get_or_init(|| TokenCache::new(4096))
}

/// Constructing a BPE encoder loads and merges the full vocabulary — an
/// expensive operation that must happen ONCE per process, not once per cache
/// miss. Each encoding family gets its own lazily-initialized static.
#[cfg(feature = "addon")]
fn bpe_for(family: EncodingFamily) -> Result<&'static tiktoken_rs::CoreBPE, String> {
    use std::sync::OnceLock;
    use tiktoken_rs::{cl100k_base, o200k_base, r50k_base};

    static O200K: OnceLock<Option<tiktoken_rs::CoreBPE>> = OnceLock::new();
    static CL100K: OnceLock<Option<tiktoken_rs::CoreBPE>> = OnceLock::new();
    static R50K: OnceLock<Option<tiktoken_rs::CoreBPE>> = OnceLock::new();

    let (slot, load): (
        &OnceLock<Option<tiktoken_rs::CoreBPE>>,
        fn() -> Result<tiktoken_rs::CoreBPE, String>,
    ) = match family {
        EncodingFamily::O200k => (&O200K, || o200k_base().map_err(|e| e.to_string())),
        EncodingFamily::Cl100k => (&CL100K, || cl100k_base().map_err(|e| e.to_string())),
        EncodingFamily::R50k => (&R50K, || r50k_base().map_err(|e| e.to_string())),
    };

    slot.get_or_init(|| load().ok())
        .as_ref()
        .ok_or_else(|| format!("failed to initialize {family:?} BPE vocabulary"))
}

/// Count tokens for a text string using the specified encoding family with caching.
#[cfg(feature = "addon")]
pub fn count_tokens(text: &str, family: EncodingFamily) -> Result<usize, String> {
    if text.is_empty() {
        return Ok(0);
    }
    let cache = global_token_cache();
    if let Some(cached) = cache.get(family, text) {
        return Ok(cached);
    }

    let bpe = bpe_for(family)?;
    let count = bpe.encode_with_special_tokens(text).len();
    cache.insert(family, text, count);
    Ok(count)
}

/// Fallback when addon feature is not enabled — uses heuristic.
#[cfg(not(feature = "addon"))]
pub fn count_tokens(text: &str, _family: EncodingFamily) -> Result<usize, String> {
    Ok((text.len() as f64 / 4.0).ceil() as usize)
}

/// Estimate message tokens including per-message overhead (~4 tokens for role/formatting).
#[cfg(feature = "addon")]
pub fn count_messages_tokens(
    messages: &[(&str, &str)],
    family: EncodingFamily,
) -> Result<usize, String> {
    let mut total: usize = 0;
    for (_role, content) in messages {
        total += 4; // per-message overhead
        total += count_tokens(content, family)?;
    }
    total += 2; // reply priming
    Ok(total)
}

#[cfg(not(feature = "addon"))]
pub fn count_messages_tokens(
    messages: &[(&str, &str)],
    family: EncodingFamily,
) -> Result<usize, String> {
    let mut total: usize = 0;
    for (_role, content) in messages {
        total += 4;
        total += count_tokens(content, family)?;
    }
    total += 2;
    Ok(total)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_family_from_model() {
        assert_eq!(EncodingFamily::from_model("gpt-4o"), EncodingFamily::O200k);
        assert_eq!(
            EncodingFamily::from_model("gpt-4o-mini"),
            EncodingFamily::O200k
        );
        assert_eq!(
            EncodingFamily::from_model("o1-preview"),
            EncodingFamily::O200k
        );
        assert_eq!(
            EncodingFamily::from_model("gpt-4-turbo"),
            EncodingFamily::Cl100k
        );
        assert_eq!(
            EncodingFamily::from_model("gpt-3.5-turbo"),
            EncodingFamily::Cl100k
        );
        assert_eq!(
            EncodingFamily::from_model("claude-3-opus"),
            EncodingFamily::Cl100k
        );
        assert_eq!(
            EncodingFamily::from_model("unknown-model"),
            EncodingFamily::Cl100k
        );
    }

    #[test]
    fn token_cache_hit_and_evict() {
        let cache = TokenCache::new(2);
        cache.insert(EncodingFamily::Cl100k, "test string 1", 10);
        assert_eq!(cache.get(EncodingFamily::Cl100k, "test string 1"), Some(10));
        assert_eq!(cache.get(EncodingFamily::Cl100k, "nonexistent"), None);

        cache.insert(EncodingFamily::Cl100k, "test string 2", 20);
        cache.insert(EncodingFamily::Cl100k, "test string 3", 30); // causes clear
        assert_eq!(cache.get(EncodingFamily::Cl100k, "test string 3"), Some(30));
    }

    #[cfg(feature = "addon")]
    #[test]
    fn exact_count_nonempty() {
        let count = count_tokens("Hello, world!", EncodingFamily::Cl100k).unwrap();
        assert!(count > 0, "non-empty text should have >0 tokens");
        assert!(
            count <= 10,
            "short text should have few tokens, got {count}"
        );
    }

    #[cfg(feature = "addon")]
    #[test]
    fn exact_count_empty() {
        let count = count_tokens("", EncodingFamily::Cl100k).unwrap();
        assert_eq!(count, 0);
    }

    #[cfg(feature = "addon")]
    #[test]
    fn messages_overhead() {
        let msgs = vec![("system", "You are helpful."), ("user", "Hi")];
        let total = count_messages_tokens(&msgs, EncodingFamily::Cl100k).unwrap();
        assert!(total >= 10, "messages should include overhead, got {total}");
    }

    #[cfg(not(feature = "addon"))]
    #[test]
    fn fallback_heuristic() {
        let count = count_tokens("Hello, world!", EncodingFamily::Cl100k).unwrap();
        assert_eq!(count, 4);
    }
}
