//! ghita-store — NAPI bindings (feature "addon")
//! Exposes KvStore operations to Node.js via napi-rs.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::KvStore;

#[napi]
pub struct NativeStore {
    inner: KvStore,
}

#[napi]
impl NativeStore {
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let inner = KvStore::open(&path).map_err(|e| Error::from_reason(format!("{}", e)))?;
        Ok(NativeStore { inner })
    }

    #[napi]
    pub fn get(&self, key: String) -> Result<Option<String>> {
        self.inner
            .get(&key)
            .map_err(|e| Error::from_reason(format!("{}", e)))
    }

    #[napi]
    pub fn set(&self, key: String, value: String) -> Result<()> {
        self.inner
            .set(&key, &value)
            .map_err(|e| Error::from_reason(format!("{}", e)))
    }

    /// Set many pairs in one transaction (one commit for the whole batch).
    #[napi]
    pub fn set_many(&self, keys: Vec<String>, values: Vec<String>) -> Result<()> {
        if keys.len() != values.len() {
            return Err(Error::from_reason(
                "set_many requires keys.len() == values.len()".to_string(),
            ));
        }
        let entries: Vec<(&str, &str)> = keys
            .iter()
            .zip(values.iter())
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        self.inner
            .set_many(&entries)
            .map_err(|e| Error::from_reason(format!("{}", e)))
    }

    #[napi]
    pub fn delete(&self, key: String) -> Result<bool> {
        self.inner
            .delete(&key)
            .map_err(|e| Error::from_reason(format!("{}", e)))
    }

    #[napi]
    pub fn keys(&self) -> Result<Vec<String>> {
        self.inner
            .keys()
            .map_err(|e| Error::from_reason(format!("{}", e)))
    }

    #[napi]
    pub fn count(&self) -> Result<u32> {
        self.inner
            .count()
            .map(|c| c as u32)
            .map_err(|e| Error::from_reason(format!("{}", e)))
    }
    // ---- T4 (v0.0.2-preview): vector store (sqlite-vec) --------------------

    /// Ensure vec0 schema exists (dim = embedding dimensions).
    #[napi]
    pub fn vec_ensure_schema(&mut self, dim: u32) -> Result<()> {
        #[cfg(feature = "vec")]
        {
            self.inner
                .vec_ensure_schema(dim as usize)
                .map_err(|e| Error::from_reason(format!("{}", e)))
        }
        #[cfg(not(feature = "vec"))]
        {
            Err(Error::from_reason("vec feature not enabled in this build"))
        }
    }

    /// Upsert one embedding + doc.
    #[napi]
    pub fn vec_store(
        &mut self,
        id: String,
        text: String,
        vec: Float32Array,
        metadata: String,
    ) -> Result<()> {
        #[cfg(feature = "vec")]
        {
            self.inner
                .vec_store(&id, &text, &vec, &metadata)
                .map_err(|e| Error::from_reason(format!("{}", e)))
        }
        #[cfg(not(feature = "vec"))]
        {
            Err(Error::from_reason("vec feature not enabled in this build"))
        }
    }

    /// KNN search — k nearest hits, score = 1/(1+distance).
    #[napi]
    pub fn vec_search(&self, query: Float32Array, k: u32) -> Result<Vec<VecHit>> {
        #[cfg(feature = "vec")]
        {
            self.inner
                .vec_search(&query, k as usize)
                .map(|hits| {
                    hits.into_iter()
                        .map(|h| VecHit {
                            id: h.id,
                            text: h.text,
                            metadata: h.metadata,
                            score: h.score,
                        })
                        .collect()
                })
                .map_err(|e| Error::from_reason(format!("{}", e)))
        }
        #[cfg(not(feature = "vec"))]
        {
            Err(Error::from_reason("vec feature not enabled in this build"))
        }
    }

    /// Delete one doc by id.
    #[napi]
    pub fn vec_delete(&self, id: String) -> Result<bool> {
        #[cfg(feature = "vec")]
        {
            self.inner
                .vec_delete(&id)
                .map_err(|e| Error::from_reason(format!("{}", e)))?;
            Ok(true)
        }
        #[cfg(not(feature = "vec"))]
        {
            Err(Error::from_reason("vec feature not enabled in this build"))
        }
    }

    /// Number of stored docs.
    #[napi]
    pub fn vec_count(&self) -> Result<u32> {
        #[cfg(feature = "vec")]
        {
            Ok(self
                .inner
                .vec_count()
                .map_err(|e| Error::from_reason(format!("{}", e)))? as u32)
        }
        #[cfg(not(feature = "vec"))]
        {
            Err(Error::from_reason("vec feature not enabled in this build"))
        }
    }
}

// ---- T4 (v0.0.2-preview): vector store napi types -----------------------

#[cfg(feature = "vec")]
#[napi(object)]
pub struct VecHit {
    pub id: String,
    pub text: String,
    pub metadata: String,
    pub score: f64,
}
