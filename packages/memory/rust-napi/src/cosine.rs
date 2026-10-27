// ==============================================================================
// Ghita Agent — SIMD Cosine Similarity (Phase 3 Rust NAPI)
// ==============================================================================
//
// High-performance cosine similarity using manual SIMD-like unrolled chunks
// and f32 for maximum throughput. The JS layer sends f64 arrays which we
// convert to f32 internally (embedding vectors are typically 768/1536-dim
// and f32 precision is more than sufficient for similarity ranking).
//
// Exports via NAPI:
//   - cosineSimilarity(a: number[], b: number[]) -> number
//   - batchCosineSimilarity(query: number[], candidates: number[][]) -> number[]
// ==============================================================================

use rayon::prelude::*;

// ---------------------------------------------------------------------------
// Core SIMD-style cosine on f32 slices
// ---------------------------------------------------------------------------

/// Cosine similarity on f32 slices. Uses unrolled chunks of 8 for
/// compiler auto-vectorisation (AVX2 on x86_64, NEON on aarch64).
#[inline]
pub fn cosine_f32(a: &[f32], b: &[f32]) -> f64 {
    let len = a.len().min(b.len());
    if len == 0 {
        return 0.0;
    }

    // SAFETY invariants for the unsafe blocks below:
    //   - `base + 7 < len`  ⟺ `i < chunks` because `chunks = len / 8`.
    //     We add a debug-build assert so an off-by-one (e.g. someone
    //     changing the chunk size) is caught immediately, while the
    //     production build keeps the hot path branch-free.
    let mut dot: f32 = 0.0;
    let mut norm_a: f32 = 0.0;
    let mut norm_b: f32 = 0.0;

    // Unrolled chunks of 8 — the compiler will emit SIMD instructions
    // (AVX2: 8 floats per `__m256`, NEON: 4 floats per `float32x4_t`
    // unrolled 2x). On AVX-512 the same code widens to 16 floats per
    // iteration, so we get a 2x speedup with no source change.
    let chunks = len / 8;
    let remainder = len % 8;

    for i in 0..chunks {
        let base = i * 8;
        // SAFETY: see doc comment above.
        unsafe {
            debug_assert!(base + 7 < len, "chunk OOB: base={base} len={len}");
            let a0 = *a.get_unchecked(base);
            let a1 = *a.get_unchecked(base + 1);
            let a2 = *a.get_unchecked(base + 2);
            let a3 = *a.get_unchecked(base + 3);
            let a4 = *a.get_unchecked(base + 4);
            let a5 = *a.get_unchecked(base + 5);
            let a6 = *a.get_unchecked(base + 6);
            let a7 = *a.get_unchecked(base + 7);

            let b0 = *b.get_unchecked(base);
            let b1 = *b.get_unchecked(base + 1);
            let b2 = *b.get_unchecked(base + 2);
            let b3 = *b.get_unchecked(base + 3);
            let b4 = *b.get_unchecked(base + 4);
            let b5 = *b.get_unchecked(base + 5);
            let b6 = *b.get_unchecked(base + 6);
            let b7 = *b.get_unchecked(base + 7);

            dot += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3 + a4 * b4 + a5 * b5 + a6 * b6 + a7 * b7;
            norm_a += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3 + a4 * a4 + a5 * a5 + a6 * a6 + a7 * a7;
            norm_b += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3 + b4 * b4 + b5 * b5 + b6 * b6 + b7 * b7;
        }
    }

    // Scalar tail
    let tail_start = chunks * 8;
    for i in tail_start..tail_start + remainder {
        let va = a[i];
        let vb = b[i];
        dot += va * vb;
        norm_a += va * va;
        norm_b += vb * vb;
    }

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    (dot as f64) / ((norm_a as f64).sqrt() * (norm_b as f64).sqrt())
}

/// Convert f64 (JS number[]) to f32 for SIMD processing.
#[inline]
pub fn to_f32(v: &[f64]) -> Vec<f32> {
    v.iter().map(|&x| x as f32).collect()
}

// ---------------------------------------------------------------------------
// NAPI exports
// ---------------------------------------------------------------------------

/// Cosine similarity between two vectors.
/// JS: cosineSimilarity(a: number[], b: number[]) -> number
#[napi]
pub fn cosine_similarity(a: Vec<f64>, b: Vec<f64>) -> f64 {
    let af = to_f32(&a);
    let bf = to_f32(&b);
    cosine_f32(&af, &bf)
}

/// Batch cosine similarity: one query against many candidates.
/// Uses rayon for parallel computation across candidates.
/// JS: batchCosineSimilarity(query: number[], candidates: number[][]) -> number[]
#[napi]
pub fn batch_cosine_similarity(query: Vec<f64>, candidates: Vec<Vec<f64>>) -> Vec<f64> {
    let qf = to_f32(&query);
    candidates
        .par_iter()
        .map(|c| {
            let cf = to_f32(c);
            cosine_f32(&qf, &cf)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_identical_vectors() {
        let a = vec![1.0f32, 2.0, 3.0, 4.0];
        let score = cosine_f32(&a, &a);
        assert!((score - 1.0).abs() < 1e-6, "identical vectors should have cosine ~1.0, got {score}");
    }

    #[test]
    fn test_orthogonal_vectors() {
        let a = vec![1.0f32, 0.0];
        let b = vec![0.0f32, 1.0];
        let score = cosine_f32(&a, &b);
        assert!(score.abs() < 1e-6, "orthogonal vectors should have cosine ~0.0, got {score}");
    }

    #[test]
    fn test_opposite_vectors() {
        let a = vec![1.0f32, 2.0, 3.0];
        let b = vec![-1.0f32, -2.0, -3.0];
        let score = cosine_f32(&a, &b);
        assert!((score - (-1.0)).abs() < 1e-6, "opposite vectors should have cosine ~-1.0, got {score}");
    }

    #[test]
    fn test_empty_vectors() {
        let a: Vec<f32> = vec![];
        let b: Vec<f32> = vec![];
        assert_eq!(cosine_f32(&a, &b), 0.0);
    }

    #[test]
    fn test_zero_vector() {
        let a = vec![0.0f32, 0.0, 0.0];
        let b = vec![1.0f32, 2.0, 3.0];
        assert_eq!(cosine_f32(&a, &b), 0.0);
    }

    #[test]
    fn test_large_vector() {
        let dim = 1536;
        let a: Vec<f32> = (0..dim).map(|i| (i as f32) * 0.001).collect();
        let b: Vec<f32> = (0..dim).map(|i| (i as f32) * 0.002).collect();
        let score = cosine_f32(&a, &b);
        // Same direction, should be ~1.0
        assert!((score - 1.0).abs() < 1e-4, "same direction large vectors should have cosine ~1.0, got {score}");
    }

    #[test]
    fn test_unequal_length() {
        let a = vec![1.0f32, 2.0, 3.0, 4.0, 5.0];
        let b = vec![1.0f32, 2.0, 3.0];
        // Should use min length = 3
        let score = cosine_f32(&a, &b);
        let expected = cosine_f32(&a[..3], &b[..3]);
        assert!((score - expected).abs() < 1e-6);
    }
}
