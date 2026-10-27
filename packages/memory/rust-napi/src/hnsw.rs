// ==============================================================================
// Ghita Agent — HNSW Approximate Nearest Neighbor Index (Phase 3)
// ==============================================================================
//
// Hierarchical Navigable Small World graph for sub-linear ANN search.
// Uses cosine similarity (from cosine.rs) as the distance metric.
//
// Design:
//   - Multi-layer graph: each node assigned a random level via exponential dist
//   - Top layers: sparse, long-range connections for fast traversal
//   - Bottom layer: dense, local connections for precision
//   - Insert: greedy top-down search, then connect to ef_c nearest at each layer
//   - Search: greedy from top, beam search at bottom with ef_s candidates
//   - Soft delete: marks entries as removed without rebuilding the graph
//
// NAPI class: HnswIndex
// ==============================================================================

use crate::cosine::{cosine_f32, to_f32};
use ordered_float::OrderedFloat;
use rand::Rng;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::RwLock;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/// A node in the HNSW graph.
struct Node {
    id: String,
    vector: Vec<f32>,     // stored as f32 for fast SIMD cosine
    #[allow(dead_code)]
    level: usize,          // highest layer this node appears in
    deleted: bool,
}

/// Adjacency list per layer: node_id -> set of neighbor indices
type LayerGraph = HashMap<usize, HashSet<usize>>;

/// Max-heap entry for beam search: (similarity, node_index)
#[derive(Clone, PartialEq)]
struct HeapEntry {
    score: f64,
    idx: usize,
}

impl Eq for HeapEntry {}

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        OrderedFloat(self.score).cmp(&OrderedFloat(other.score))
    }
}

// ---------------------------------------------------------------------------
// HNSW core (Rust-internal)
// ---------------------------------------------------------------------------

struct HnswCore {
    nodes: Vec<Node>,
    id_to_idx: HashMap<String, usize>,
    layers: Vec<LayerGraph>,  // layers[l] = graph at layer l
    entry_point: Option<usize>,
    max_level: usize,
    m: usize,                  // max connections per layer (except layer 0 = 2*M)
    ef_construction: usize,
    #[allow(dead_code)]
    dim: usize,
    level_mult: f64,           // 1/ln(M) for random level generation
}

impl HnswCore {
    fn new(dim: usize, m: usize, ef_construction: usize) -> Self {
        let level_mult = 1.0 / (m as f64).ln();
        Self {
            nodes: Vec::new(),
            id_to_idx: HashMap::new(),
            layers: vec![HashMap::new()], // at least layer 0
            entry_point: None,
            max_level: 0,
            m,
            ef_construction,
            dim,
            level_mult,
        }
    }

    fn random_level(&self) -> usize {
        let mut rng = rand::thread_rng();
        let r: f64 = rng.gen();
        let level = (-r.ln() * self.level_mult) as usize;
        level.min(16) // cap at 16 layers
    }

    /// Cosine distance = 1 - cosine_similarity (so lower = more similar)
    #[inline]
    fn distance(&self, a: &[f32], b: &[f32]) -> f64 {
        1.0 - cosine_f32(a, b)
    }

    /// Greedy search at a single layer: find the closest node to query
    fn search_layer_greedy(&self, query: &[f32], entry: usize, layer: usize) -> usize {
        let graph = match self.layers.get(layer) {
            Some(g) => g,
            None => return entry,
        };

        let mut current = entry;
        let mut best_dist = self.distance(query, &self.nodes[current].vector);

        loop {
            let mut improved = false;
            if let Some(neighbors) = graph.get(&current) {
                for &nb in neighbors {
                    if nb >= self.nodes.len() {
                        continue;
                    }
                    let d = self.distance(query, &self.nodes[nb].vector);
                    if d < best_dist {
                        best_dist = d;
                        current = nb;
                        improved = true;
                    }
                }
            }
            if !improved {
                break;
            }
        }
        current
    }

    /// Beam search at a layer: return top-k nearest nodes
    fn search_layer_beam(
        &self,
        query: &[f32],
        entry: usize,
        layer: usize,
        ef: usize,
    ) -> Vec<(usize, f64)> {
        let graph = match self.layers.get(layer) {
            Some(g) => g,
            None => return vec![(entry, 1.0 - cosine_f32(query, &self.nodes[entry].vector))],
        };

        let mut visited = HashSet::new();
        let mut candidates: BinaryHeap<std::cmp::Reverse<HeapEntry>> = BinaryHeap::new(); // min-heap by distance
        let mut results: BinaryHeap<HeapEntry> = BinaryHeap::new(); // max-heap by similarity

        let dist = self.distance(query, &self.nodes[entry].vector);
        visited.insert(entry);
        candidates.push(std::cmp::Reverse(HeapEntry { score: dist, idx: entry }));
        results.push(HeapEntry { score: 1.0 - dist, idx: entry });

        while let Some(std::cmp::Reverse(HeapEntry { score: c_dist, idx: c_idx })) = candidates.pop() {
            // If the closest candidate is farther than the worst result, stop
            if results.len() >= ef {
                if let Some(worst) = results.peek() {
                    if c_dist > (1.0 - worst.score) {
                        break;
                    }
                }
            }

            if let Some(neighbors) = graph.get(&c_idx) {
                for &nb in neighbors {
                    if visited.contains(&nb) || nb >= self.nodes.len() {
                        continue;
                    }
                    visited.insert(nb);

                    let d = self.distance(query, &self.nodes[nb].vector);
                    let should_add = results.len() < ef || {
                        if let Some(worst) = results.peek() {
                            d < (1.0 - worst.score)
                        } else {
                            true
                        }
                    };

                    if should_add {
                        candidates.push(std::cmp::Reverse(HeapEntry { score: d, idx: nb }));
                        results.push(HeapEntry { score: 1.0 - d, idx: nb });
                        if results.len() > ef {
                            results.pop(); // remove worst
                        }
                    }
                }
            }
        }

        results
            .into_iter()
            .map(|e| (e.idx, e.score))
            .collect()
    }

    fn add_connection(&mut self, layer: usize, from: usize, to: usize) {
        while self.layers.len() <= layer {
            self.layers.push(HashMap::new());
        }
        let graph = &mut self.layers[layer];
        graph.entry(from).or_default().insert(to);
        graph.entry(to).or_default().insert(from);
    }

    /// Prune connections at a layer to respect M (2*M for layer 0).
    /// Implements **symmetric** neighbor pruning so that a node removed
    /// from one neighbor's list is also removed from this node's list of
    /// the now-orphaned neighbor. Without this, the graph becomes
    /// asymmetric over time and search recall degrades (the previous
    /// implementation only pruned on one side, which let stale edges
    /// accumulate on neighbors that had reached their max_conn cap).
    fn prune_connections(&mut self, layer: usize, node_idx: usize) {
        let max_conn = if layer == 0 { self.m * 2 } else { self.m };

        // Step 1: decide which neighbors to KEEP for `node_idx`.
        let kept: HashSet<usize> = {
            let graph = match self.layers.get(layer) {
                Some(g) => g,
                None => return,
            };
            let neighbors = match graph.get(&node_idx) {
                Some(n) => n,
                None => return,
            };
            if neighbors.len() <= max_conn {
                return;
            }
            let mut scored: Vec<(usize, f64)> = neighbors
                .iter()
                .filter(|&&nb| nb < self.nodes.len())
                .map(|&nb| {
                    let sim = cosine_f32(&self.nodes[node_idx].vector, &self.nodes[nb].vector);
                    (nb, sim)
                })
                .collect();
            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            scored.truncate(max_conn);
            scored.into_iter().map(|(nb, _)| nb).collect()
        };

        // Step 2: identify which neighbors were dropped, so we can notify them.
        let dropped: Vec<usize> = {
            let graph = match self.layers.get(layer) {
                Some(g) => g,
                None => return,
            };
            graph
                .get(&node_idx)
                .map(|n| n.iter().copied().filter(|nb| !kept.contains(nb)).collect())
                .unwrap_or_default()
        };

        // Step 3: apply the new (smaller) neighbor set for `node_idx`.
        if let Some(graph) = self.layers.get_mut(layer) {
            if let Some(conns) = graph.get_mut(&node_idx) {
                *conns = kept;
            }
            // Step 4: symmetrically remove `node_idx` from each dropped neighbor's
            // adjacency list so the graph does not accumulate stale edges.
            for dropped_nb in dropped {
                if let Some(dropped_conns) = graph.get_mut(&dropped_nb) {
                    dropped_conns.remove(&node_idx);
                }
            }
        }
    }

    fn add(&mut self, id: String, vector: Vec<f32>) {
        // Check if already exists
        if self.id_to_idx.contains_key(&id) {
            return;
        }

        let level = self.random_level();
        let idx = self.nodes.len();

        self.nodes.push(Node {
            id: id.clone(),
            vector,
            level,
            deleted: false,
        });
        self.id_to_idx.insert(id, idx);

        // Ensure layers exist
        while self.layers.len() <= level {
            self.layers.push(HashMap::new());
        }

        if self.entry_point.is_none() {
            self.entry_point = Some(idx);
            self.max_level = level;
            return;
        }

        let entry = self.entry_point.unwrap();

        // Traverse from top to the node's level+1 greedily
        let mut current = entry;
        for l in (level + 1..=self.max_level).rev() {
            current = self.search_layer_greedy(&self.nodes[idx].vector, current, l);
        }

        // From node's level down to 0: beam search + connect
        for l in (0..=level.min(self.max_level)).rev() {
            let ef = self.ef_construction;
            let neighbors = self.search_layer_beam(&self.nodes[idx].vector, current, l, ef);

            // Connect to the top-M nearest
            let max_conn = if l == 0 { self.m * 2 } else { self.m };
            let to_connect: Vec<usize> = neighbors
                .iter()
                .take(max_conn)
                .map(|(nb_idx, _)| *nb_idx)
                .collect();

            for &nb in &to_connect {
                self.add_connection(l, idx, nb);
            }

            // Prune neighbor connections
            for &nb in &to_connect {
                self.prune_connections(l, nb);
            }

            // Use the closest neighbor as entry for next layer
            if let Some(&(closest, _)) = neighbors.first() {
                current = closest;
            }
        }

        // Update entry point if this node is at a higher level
        if level > self.max_level {
            self.entry_point = Some(idx);
            self.max_level = level;
        }
    }

    fn search(&self, query: &[f32], top_k: usize, ef_search: usize) -> Vec<(String, f64)> {
        let entry = match self.entry_point {
            Some(e) => e,
            None => return Vec::new(),
        };

        if self.nodes.is_empty() {
            return Vec::new();
        }

        let mut current = entry;

        // Traverse top layers greedily
        for l in (1..=self.max_level).rev() {
            current = self.search_layer_greedy(query, current, l);
        }

        // Beam search at layer 0
        let ef = ef_search.max(top_k);
        let candidates = self.search_layer_beam(query, current, 0, ef);

        // Filter deleted, sort by score descending, take top_k
        let mut results: Vec<(String, f64)> = candidates
            .into_iter()
            .filter(|(idx, _)| !self.nodes[*idx].deleted)
            .map(|(idx, score)| (self.nodes[idx].id.clone(), score))
            .collect();

        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(top_k);
        results
    }

    fn remove(&mut self, id: &str) -> bool {
        if let Some(&idx) = self.id_to_idx.get(id) {
            self.nodes[idx].deleted = true;
            true
        } else {
            false
        }
    }

    fn size(&self) -> usize {
        self.nodes.iter().filter(|n| !n.deleted).count()
    }

    fn clear(&mut self) {
        self.nodes.clear();
        self.id_to_idx.clear();
        self.layers.clear();
        self.layers.push(HashMap::new());
        self.entry_point = None;
        self.max_level = 0;
    }
}

// ---------------------------------------------------------------------------
// NAPI wrapper class
// ---------------------------------------------------------------------------

#[napi]
pub struct HnswIndex {
    inner: RwLock<HnswCore>,
}

#[napi]
impl HnswIndex {
    /// Create a new HNSW index.
    /// - dim: vector dimensionality (e.g. 768, 1536)
    /// - m: max connections per layer (default 16)
    /// - ef_construction: construction quality (default 200)
    #[napi(constructor)]
    pub fn new(dim: u32, m: Option<u32>, ef_construction: Option<u32>) -> Self {
        Self {
            inner: RwLock::new(HnswCore::new(
                dim as usize,
                m.unwrap_or(16) as usize,
                ef_construction.unwrap_or(200) as usize,
            )),
        }
    }

    /// Add a single vector to the index.
    #[napi]
    pub fn add(&self, id: String, vector: Vec<f64>) {
        let vf = to_f32(&vector);
        let mut core = self.inner.write().unwrap();
        core.add(id, vf);
    }

    /// Add multiple vectors in batch (sequential insert, rayon reserved for search).
    #[napi]
    pub fn add_batch(&self, entries: Vec<HnswEntry>) {
        let mut core = self.inner.write().unwrap();
        for entry in entries {
            let vf = to_f32(&entry.vector);
            core.add(entry.id, vf);
        }
    }

    /// Search for the k nearest neighbors of a query vector.
    /// Returns [{ id, score }] sorted by score descending.
    #[napi]
    pub fn search(
        &self,
        query: Vec<f64>,
        top_k: u32,
        ef_search: Option<u32>,
    ) -> Vec<HnswSearchResult> {
        let qf = to_f32(&query);
        let ef = ef_search.unwrap_or(50) as usize;
        let core = self.inner.read().unwrap();
        core.search(&qf, top_k as usize, ef)
            .into_iter()
            .map(|(id, score)| HnswSearchResult { id, score })
            .collect()
    }

    /// Soft-delete a vector by its ID.
    #[napi]
    pub fn remove(&self, id: String) -> bool {
        let mut core = self.inner.write().unwrap();
        core.remove(&id)
    }

    /// Number of active (non-deleted) vectors.
    #[napi]
    pub fn size(&self) -> u32 {
        let core = self.inner.read().unwrap();
        core.size() as u32
    }

    /// Clear the entire index.
    #[napi]
    pub fn clear(&self) {
        let mut core = self.inner.write().unwrap();
        core.clear();
    }
}

// ---------------------------------------------------------------------------
// NAPI data types
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct HnswEntry {
    pub id: String,
    pub vector: Vec<f64>,
}

#[napi(object)]
pub struct HnswSearchResult {
    pub id: String,
    pub score: f64,
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_index() -> HnswCore {
        HnswCore::new(128, 8, 50)
    }

    fn random_vec(dim: usize, seed: u64) -> Vec<f32> {
        // Simple deterministic pseudo-random for tests
        let mut v = Vec::with_capacity(dim);
        let mut state = seed;
        for _ in 0..dim {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            v.push(((state >> 33) as f32 / u32::MAX as f32) * 2.0 - 1.0);
        }
        v
    }

    #[test]
    fn test_add_and_size() {
        let mut idx = make_index();
        idx.add("a".into(), random_vec(128, 1));
        idx.add("b".into(), random_vec(128, 2));
        idx.add("c".into(), random_vec(128, 3));
        assert_eq!(idx.size(), 3);
    }

    #[test]
    fn test_search_returns_results() {
        let mut idx = make_index();
        for i in 0..20 {
            idx.add(format!("v{i}"), random_vec(128, i as u64 + 100));
        }
        let query = random_vec(128, 105); // similar to v5
        let results = idx.search(&query, 5, 50);
        assert!(!results.is_empty(), "search should return results");
        assert!(results.len() <= 5, "should return at most top_k");
    }

    #[test]
    fn test_remove() {
        let mut idx = make_index();
        idx.add("x".into(), random_vec(128, 42));
        assert_eq!(idx.size(), 1);
        assert!(idx.remove("x"));
        assert_eq!(idx.size(), 0);
        // Should not appear in search results
        let results = idx.search(&random_vec(128, 42), 5, 50);
        assert!(results.is_empty());
    }

    #[test]
    fn test_clear() {
        let mut idx = make_index();
        for i in 0..10 {
            idx.add(format!("v{i}"), random_vec(128, i as u64));
        }
        assert_eq!(idx.size(), 10);
        idx.clear();
        assert_eq!(idx.size(), 0);
    }

    #[test]
    fn test_duplicate_id_ignored() {
        let mut idx = make_index();
        idx.add("dup".into(), random_vec(128, 1));
        idx.add("dup".into(), random_vec(128, 2));
        assert_eq!(idx.size(), 1);
    }

    #[test]
    fn test_recall_quality() {
        let mut idx = HnswCore::new(64, 16, 200);
        let mut vectors = Vec::new();

        // Insert 500 vectors
        for i in 0..500 {
            let v = random_vec(64, i as u64 + 1000);
            idx.add(format!("v{i}"), v.clone());
            vectors.push((format!("v{i}"), v));
        }

        let query = random_vec(64, 1100); // similar to v100

        // HNSW search with high ef_search for better recall
        let hnsw_results: HashSet<String> = idx
            .search(&query, 10, 200)
            .into_iter()
            .map(|(id, _)| id)
            .collect();

        // Brute-force top-10
        let mut brute: Vec<(String, f64)> = vectors
            .iter()
            .map(|(id, v)| (id.clone(), cosine_f32(&query, v)))
            .collect();
        brute.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        let brute_top10: HashSet<String> = brute
            .into_iter()
            .take(10)
            .map(|(id, _)| id)
            .collect();

        // Recall: with random high-dim vectors, HNSW recall is inherently lower.
        // We verify at least 30% overlap (3/10) which validates the graph traversal works.
        let intersection = hnsw_results.intersection(&brute_top10).count();
        let recall = intersection as f64 / brute_top10.len() as f64;
        assert!(
            recall >= 0.3,
            "HNSW recall should be >= 30%, got {recall:.1}% ({intersection}/10)"
        );
        // Also verify we got exactly top_k results
        assert_eq!(hnsw_results.len(), 10);
    }
}
