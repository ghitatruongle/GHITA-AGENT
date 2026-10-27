// ==============================================================================
// Ghita Agent — Memory NAPI Module Entry Point (Phase 3)
// ==============================================================================
//
// This crate compiles to a Node.js native addon (.node) that provides:
//   - SIMD cosine similarity (cosine.rs)
//   - HNSW approximate nearest-neighbor index (hnsw.rs)
//   - Parallel decay scoring via rayon (decay.rs)
//
// Loaded by: packages/memory/src/semantic/rustAddon.ts via require('./rust/index.node')
// ==============================================================================

#[macro_use]
extern crate napi_derive;

pub mod cosine;
pub mod hnsw;
pub mod decay;
