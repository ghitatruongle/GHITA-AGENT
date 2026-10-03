//! ghita-retrieval — inverted-index BM25 + Vector + RRF Fusion core
//!
//! Combines:
//! 1. Inverted-index BM25 with O(1) DF lookups and precomputed chunk length normalization.
//! 2. Vector Cosine Similarity and fast top-K vector search.
//! 3. Reciprocal Rank Fusion (RRF k=60) for multi-source hybrid search.
//! 4. Unicode CJK/Vietnamese n-gram tokenization support.
//!
//! Std-only (HashMap + Vec) so `cargo test` runs offline; addon exposes napi.

pub mod importance;
pub mod incremental;
pub mod splitters;

// `#[napi]` sinh ra mã đăng ký hàm vào addon, mà phân tích dead-code của
// clippy không nhìn thấy — nên mọi hàm export trong đây đều bị báo "never
// used" dù chúng thật sự được gọi từ JS. Tắt cảnh báo cho cả module thay vì
// 7 dòng `#[allow]`, và ghi lý do để người sau không tưởng là code chết.
#[cfg(feature = "addon")]
#[allow(dead_code)]
mod napi;

use std::collections::HashMap;

/// A document chunk fed into the index.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub id: u32,
    pub text: String,
}

struct Posting {
    chunk: u32,
    tf: u32,
}

struct TermEntry {
    df: u32,
    postings: Vec<Posting>,
}

pub struct BM25Index {
    index: HashMap<String, TermEntry>,
    lengths: Vec<usize>,
    avg_len: f64,
    n: usize,
    k1: f64,
    b: f64,
}

impl BM25Index {
    /// Build the inverted index in one pass over the corpus.
    pub fn build(chunks: &[Chunk], k1: f64, b: f64) -> Self {
        let tokenized: Vec<HashMap<String, u32>> = chunks
            .iter()
            .map(|c| {
                let mut seen: HashMap<String, u32> = HashMap::new();
                for token in tokenize(&c.text) {
                    *seen.entry(token).or_insert(0) += 1;
                }
                seen
            })
            .collect();
        let lengths: Vec<usize> = chunks.iter().map(|c| c.text.len()).collect();
        Self::from_token_counts(&tokenized, &lengths, k1, b)
    }

    /// Dựng chỉ mục từ số đếm từ đã tính sẵn.
    ///
    /// Tách riêng khỏi `build` để `incremental.rs` tái dùng được kết quả
    /// tokenize của những file KHÔNG đổi. `build` luôn phải tokenize lại toàn
    /// bộ, nên gọi nó mỗi lần re-index là tốn công vô ích — đó chính là lý do
    /// "incremental" trước đây không tăng tốc được gì.
    pub fn from_token_counts(
        tokenized: &[HashMap<String, u32>],
        lengths: &[usize],
        k1: f64,
        b: f64,
    ) -> Self {
        // Hai slice phải cùng độ dài: lệch nhau thì build vẫn "thành công" nhưng
        // `query` sau đó panic index-out-of-bounds — xa gọi lỗi gấp mùa, và qua
        // napi là đau cả process Node. Chặn ở đây với thông báo rõ ràng.
        assert_eq!(
            tokenized.len(),
            lengths.len(),
            "from_token_counts: tokenized ({}) và lengths ({}) phải cùng độ dài",
            tokenized.len(),
            lengths.len()
        );
        let n = tokenized.len();
        let total: usize = lengths.iter().sum();
        let avg_len = total as f64 / n.max(1) as f64;
        let mut index: HashMap<String, TermEntry> = HashMap::new();

        for (ci, seen) in tokenized.iter().enumerate() {
            for (token, tf) in seen {
                let entry = index.entry(token.clone()).or_insert(TermEntry {
                    df: 0,
                    postings: Vec::new(),
                });
                entry.df += 1;
                entry.postings.push(Posting {
                    chunk: ci as u32,
                    tf: *tf,
                });
            }
        }

        BM25Index {
            index,
            lengths: lengths.to_vec(),
            avg_len,
            n,
            k1,
            b,
        }
    }

    /// Score every chunk once per query term (DF precomputed).
    pub fn query(&self, query: &str) -> Vec<(u32, f64)> {
        let mut scores: HashMap<u32, f64> = HashMap::new();
        for term in tokenize(query) {
            let Some(entry) = self.index.get(&term) else {
                continue;
            };
            let idf =
                (1.0 + (self.n as f64 - entry.df as f64 + 0.5) / (entry.df as f64 + 0.5)).ln();
            for posting in &entry.postings {
                let chunk_idx = posting.chunk as usize;
                // Phòng thủ: index lệch (caller dựng sai qua from_token_counts)
                // không được panic — coi chunk rỗng là đủ để trả kết quả an toàn.
                let len = self.lengths.get(chunk_idx).copied().unwrap_or(0) as f64;
                let tf_norm = (posting.tf as f64 * (self.k1 + 1.0))
                    / (posting.tf as f64
                        + self.k1 * (1.0 - self.b + self.b * (len / self.avg_len)));
                *scores.entry(posting.chunk).or_insert(0.0) += idf * tf_norm;
            }
        }
        let mut ranked: Vec<(u32, f64)> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked
    }

    pub fn size(&self) -> usize {
        self.index.len()
    }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF k=60)
// ---------------------------------------------------------------------------

/// Combine multiple ranked result lists into a single fused ranking.
/// Formula: RRF_Score(doc) = sum_{list in lists} (weight / (k + rank_in_list))
pub fn rrf_fuse(
    ranked_lists: &[Vec<u32>],
    weights: Option<&[f64]>,
    k: f64,
    top_k: usize,
) -> Vec<(u32, f64)> {
    let default_k = if k <= 0.0 { 60.0 } else { k };
    let mut scores: HashMap<u32, f64> = HashMap::new();

    for (list_idx, list) in ranked_lists.iter().enumerate() {
        let weight = weights
            .and_then(|w| w.get(list_idx).copied())
            .unwrap_or(1.0);

        for (rank_0, &doc_id) in list.iter().enumerate() {
            let rank = (rank_0 + 1) as f64;
            let score_contrib = weight / (default_k + rank);
            *scores.entry(doc_id).or_insert(0.0) += score_contrib;
        }
    }

    let mut fused: Vec<(u32, f64)> = scores.into_iter().collect();
    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    if top_k > 0 && fused.len() > top_k {
        fused.truncate(top_k);
    }
    fused
}

// ---------------------------------------------------------------------------
// Vector Cosine Similarity & Search
// ---------------------------------------------------------------------------

/// Compute cosine similarity between two float vectors.
#[inline]
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    for i in 0..a.len() {
        let va = a[i];
        let vb = b[i];
        dot += va * vb;
        norm_a += va * va;
        norm_b += vb * vb;
    }

    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom > 1e-9 {
        dot / denom
    } else {
        0.0
    }
}

/// Search top-k most similar vectors in a corpus given a query embedding.
pub fn vector_search(
    query: &[f32],
    corpus_ids: &[u32],
    corpus_vectors: &[Vec<f32>],
    top_k: usize,
) -> Vec<(u32, f32)> {
    if corpus_ids.len() != corpus_vectors.len() || query.is_empty() {
        return Vec::new();
    }

    let mut scores: Vec<(u32, f32)> = Vec::with_capacity(corpus_ids.len());
    for (i, vec) in corpus_vectors.iter().enumerate() {
        let sim = cosine_similarity(query, vec);
        scores.push((corpus_ids[i], sim));
    }

    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    if top_k > 0 && scores.len() > top_k {
        scores.truncate(top_k);
    }
    scores
}

// ---------------------------------------------------------------------------
// Tokenizer with CJK / Vietnamese n-gram & word boundaries
// ---------------------------------------------------------------------------

/// Tokenizer: Unicode alphanumeric + CJK character bigram / unigram support.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        // CJK Unified Ideographs range
        let is_cjk = ('\u{4e00}'..='\u{9fff}').contains(&ch)
            || ('\u{3400}'..='\u{4dbf}').contains(&ch)
            || ('\u{f900}'..='\u{faff}').contains(&ch);

        if is_cjk {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            tokens.push(ch.to_string());
        } else if ch.is_alphanumeric() {
            for lower_ch in ch.to_lowercase() {
                current.push(lower_ch);
            }
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn chunks() -> Vec<Chunk> {
        vec![
            Chunk {
                id: 0,
                text: "the red fox jumps over the dog".into(),
            },
            Chunk {
                id: 1,
                text: "the blue sky is clear today".into(),
            },
            Chunk {
                id: 2,
                text: "foxes and dogs run fast in the park".into(),
            },
            Chunk {
                id: 3,
                text: "tìm kiếm tiếng Việt và thuật toán RRF".into(),
            },
        ]
    }

    #[test]
    fn ranks_relevant_chunks_first() {
        let index = BM25Index::build(&chunks(), 1.5, 0.75);
        let ranked = index.query("fox jumps");
        assert_eq!(ranked[0].0, 0);
    }

    #[test]
    fn df_is_precomputed() {
        let index = BM25Index::build(&chunks(), 1.5, 0.75);
        assert!(index.size() > 0);
        let ranked = index.query("the");
        assert!(ranked.len() >= 3);
    }

    #[test]
    fn unknown_terms_score_nothing() {
        let index = BM25Index::build(&chunks(), 1.5, 0.75);
        assert!(index.query("zzzznope").is_empty());
    }

    #[test]
    fn empty_corpus_is_safe() {
        let index = BM25Index::build(&[], 1.5, 0.75);
        assert!(index.query("fox").is_empty());
    }

    #[test]
    fn vietnamese_tokenization() {
        let tokens = tokenize("Tìm kiếm tiếng Việt");
        assert!(tokens.contains(&"tìm".to_string()));
        assert!(tokens.contains(&"kiếm".to_string()));
        assert!(tokens.contains(&"việt".to_string()));
    }

    #[test]
    fn cjk_tokenization() {
        let tokens = tokenize("Hello世界");
        assert_eq!(tokens, vec!["hello", "世", "界"]);
    }

    #[test]
    fn rrf_fusion_combines_ranks() {
        let list1 = vec![1, 2, 3];
        let list2 = vec![2, 1, 4];
        let fused = rrf_fuse(&[list1, list2], None, 60.0, 10);
        // Doc 1 and 2 are in top 2 in both lists
        assert_eq!(fused.len(), 4);
        assert!(fused[0].0 == 1 || fused[0].0 == 2);
    }

    #[test]
    fn vector_cosine_and_search() {
        let v1 = vec![1.0, 0.0, 0.0];
        let v2 = vec![0.0, 1.0, 0.0];
        let v3 = vec![0.9, 0.1, 0.0];

        let sim_1_3 = cosine_similarity(&v1, &v3);
        let sim_1_2 = cosine_similarity(&v1, &v2);
        assert!(sim_1_3 > 0.9);
        assert!(sim_1_2 < 0.01);

        let search_results =
            vector_search(&v1, &[10, 20, 30], &[v1.clone(), v2.clone(), v3.clone()], 2);
        assert_eq!(search_results[0].0, 10); // exact match
        assert_eq!(search_results[1].0, 30); // close match
    }
}
