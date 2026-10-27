// ==============================================================================
// Ghita Agent — Parallel Decay Scoring (Phase 3 Rust NAPI)
// ==============================================================================
//
// Exponential decay scoring parallelised with rayon. Used by the memory
// freshness subsystem to compute recency scores for thousands of entries
// in a single batch call instead of one-by-one in JS.
//
// Formula: Score = 2 ^ (-age / halfLife)   clamped to [0, 1]
//
// Exports via NAPI:
//   - batchDecayScore(timestamps, halfLifeMs, now) -> number[]
//   - scoreEntries(entries, query, ...) -> ScoredEntry[]
// ==============================================================================

use crate::cosine::{cosine_f32, to_f32};
use rayon::prelude::*;

// ---------------------------------------------------------------------------
// Core decay computation
// ---------------------------------------------------------------------------

/// Compute exponential decay score for a single timestamp.
#[inline]
fn decay_score(timestamp: f64, half_life_ms: f64, now: f64) -> f64 {
    if half_life_ms <= 0.0 {
        return 1.0;
    }
    let age = (now - timestamp).max(0.0);
    let score = 2.0f64.powf(-age / half_life_ms);
    score.clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// NAPI exports
// ---------------------------------------------------------------------------

/// Batch decay score: compute recency scores for an array of timestamps.
/// Parallelised via rayon — ideal for 10K-100K entries.
///
/// JS: batchDecayScore(timestamps: number[], halfLifeMs: number, now: number) -> number[]
#[napi]
pub fn batch_decay_score(timestamps: Vec<f64>, half_life_ms: f64, now: f64) -> Vec<f64> {
    timestamps
        .par_iter()
        .map(|&ts| decay_score(ts, half_life_ms, now))
        .collect()
}

/// Multi-signal entry scoring: combines recency + cosine + importance + frequency
/// in a single parallel pass. Each entry is scored independently.
///
/// JS: scoreEntries(entries: ScoringEntry[], queryVector: number[] | null,
///                  recencyWeight, semanticWeight, importanceWeight, frequencyWeight,
///                  halfLifeMs, now) -> ScoredEntry[]
#[napi]
pub fn score_entries(
    entries: Vec<ScoringEntry>,
    query_vector: Option<Vec<f64>>,
    recency_weight: f64,
    semantic_weight: f64,
    importance_weight: f64,
    frequency_weight: f64,
    half_life_ms: f64,
    now: f64,
    min_score: f64,
    limit: u32,
) -> Vec<ScoredEntry> {
    let qf = query_vector.as_ref().map(|v| to_f32(v));

    let mut scored: Vec<ScoredEntry> = entries
        .par_iter()
        .enumerate()
        .filter_map(|(i, entry)| {
            // A. Recency
            let recency = decay_score(entry.timestamp, half_life_ms, now);

            // B. Semantic (cosine similarity with query vector)
            let semantic = if let (Some(ref qv), Some(ref ev)) = (&qf, &entry.vector) {
                let ef = to_f32(ev);
                cosine_f32(qv, &ef).max(0.0) // clamp negative cosine to 0
            } else {
                0.0
            };

            // C. Importance
            let importance = entry.importance;

            // D. Frequency — use log scale so a single access contributes
            // meaningfully but we cap gracefully. The previous hardcoded
            // `access_count / 10.0` made entries with < 10 accesses score
            // near zero, which is not a smooth curve.
            let frequency = ((entry.access_count + 1.0).log2() / 4.0).clamp(0.0, 1.0);

            // Aggregate
            let score = recency_weight * recency
                + semantic_weight * semantic
                + importance_weight * importance
                + frequency_weight * frequency;

            if score >= min_score {
                Some(ScoredEntry {
                    index: i as u32,
                    id: entry.id.clone(),
                    score,
                    recency_score: recency,
                    semantic_score: semantic,
                })
            } else {
                None
            }
        })
        .collect();

    // Sort by score descending, take top limit
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit as usize);
    scored
}

// ---------------------------------------------------------------------------
// NAPI data types
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct ScoringEntry {
    pub id: String,
    pub timestamp: f64,
    pub vector: Option<Vec<f64>>,
    pub importance: f64,
    pub access_count: f64,
}

#[napi(object)]
pub struct ScoredEntry {
    pub index: u32,
    pub id: String,
    pub score: f64,
    pub recency_score: f64,
    pub semantic_score: f64,
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decay_fresh() {
        let now = 1_000_000.0;
        let half_life = 86_400_000.0; // 1 day
        let score = decay_score(now, half_life, now);
        assert!((score - 1.0).abs() < 1e-10, "fresh entry should have score ~1.0, got {score}");
    }

    #[test]
    fn test_decay_half_life() {
        let now = 1_000_000.0;
        let half_life = 86_400_000.0;
        let one_day_ago = now - half_life;
        let score = decay_score(one_day_ago, half_life, now);
        assert!((score - 0.5).abs() < 1e-10, "1 half-life old entry should have score ~0.5, got {score}");
    }

    #[test]
    fn test_decay_two_half_lives() {
        let now = 1_000_000.0;
        let half_life = 86_400_000.0;
        let two_days_ago = now - 2.0 * half_life;
        let score = decay_score(two_days_ago, half_life, now);
        assert!((score - 0.25).abs() < 1e-10, "2 half-lives old entry should have score ~0.25, got {score}");
    }

    #[test]
    fn test_decay_zero_half_life() {
        let score = decay_score(0.0, 0.0, 1000.0);
        assert_eq!(score, 1.0, "zero half-life should always return 1.0");
    }

    #[test]
    fn test_decay_future_timestamp() {
        let now = 1000.0;
        let score = decay_score(2000.0, 500.0, now);
        assert_eq!(score, 1.0, "future timestamp should clamp to 1.0");
    }

    #[test]
    fn test_batch_decay() {
        let now = 1_000_000.0;
        let half_life = 1_000.0;
        let timestamps = vec![now, now - 500.0, now - 1000.0, now - 2000.0];
        let scores = batch_decay_score(timestamps, half_life, now);
        assert_eq!(scores.len(), 4);
        assert!((scores[0] - 1.0).abs() < 1e-6);
        assert!(scores[0] > scores[1]);
        assert!(scores[1] > scores[2]);
        assert!(scores[2] > scores[3]);
    }

    #[test]
    fn test_batch_decay_large() {
        let now = 1_000_000_000.0;
        let half_life = 86_400_000.0;
        let timestamps: Vec<f64> = (0..10_000).map(|i| now - (i as f64) * 3_600_000.0).collect();
        let scores = batch_decay_score(timestamps, half_life, now);
        assert_eq!(scores.len(), 10_000);
        // Monotonically decreasing
        for i in 1..scores.len() {
            assert!(scores[i] <= scores[i - 1] + 1e-10);
        }
    }
}
