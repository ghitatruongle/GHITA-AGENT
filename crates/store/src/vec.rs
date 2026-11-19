//! Vector store (v0.0.2-preview T4) — sqlite-vec vec0 virtual tables trong
//! KvStore (rusqlite bundled). Registration 1 lần per process qua
//! sqlite3_auto_extension → mọi connection mở sau đó có sẵn `vec0`.

use std::sync::Once;

use rusqlite::OptionalExtension;

use crate::KvStore;
use crate::StoreError;

static REGISTER: Once = Once::new();

/// Đăng ký sqlite-vec vào libsqlite3 bundled — 1 lần per process.
#[allow(clippy::missing_transmute_annotations)]
pub fn ensure_registered() {
    REGISTER.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

#[derive(Debug, Clone, PartialEq)]
pub struct VecHit {
    pub id: String,
    pub text: String,
    pub metadata: String,
    pub score: f64,
}

impl KvStore {
    /// CREATE bảng vec0 + bảng doc side-car. dim = số chiều embedding.
    pub fn vec_ensure_schema(&mut self, dim: usize) -> Result<(), StoreError> {
        ensure_registered();
        self.db
            .execute_batch(&format!(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[{dim}]);\nCREATE TABLE IF NOT EXISTS memories_doc(id TEXT PRIMARY KEY, rowid_ INTEGER NOT NULL, text TEXT NOT NULL, metadata TEXT NOT NULL);"
            ))
            .map_err(|e| StoreError::Init(e.to_string()))
    }

    /// Upsert (xóa row cũ + insert) một vector + doc.
    pub fn vec_store(
        &mut self,
        id: &str,
        text: &str,
        vec: &[f32],
        metadata: &str,
    ) -> Result<(), StoreError> {
        ensure_registered();
        let old_row: Option<i64> = self
            .db
            .query_row("SELECT rowid_ FROM memories_doc WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| StoreError::Query(e.to_string()))?;
        if let Some(old) = old_row {
            self.db
                .execute("DELETE FROM memories_vec WHERE rowid = ?1", [old])
                .map_err(|e| StoreError::Query(e.to_string()))?;
            self.db
                .execute("DELETE FROM memories_doc WHERE id = ?1", [id])
                .map_err(|e| StoreError::Query(e.to_string()))?;
        }
        let vec_json = format!(
            "[{}]",
            vec.iter()
                .map(|v| format!("{v}"))
                .collect::<Vec<_>>()
                .join(",")
        );
        self.db
            .execute(
                "INSERT INTO memories_vec(rowid, embedding) VALUES ((SELECT COALESCE(MAX(rowid),0)+1 FROM memories_vec), ?1)",
                [&vec_json],
            )
            .map_err(|e| StoreError::Query(e.to_string()))?;
        let new_rowid: i64 = self
            .db
            .query_row("SELECT MAX(rowid) FROM memories_vec", [], |r| r.get(0))
            .map_err(|e| StoreError::Query(e.to_string()))?;
        self.db
            .execute(
                "INSERT INTO memories_doc(id, rowid_, text, metadata) VALUES (?1, ?2, ?3, ?4)",
                [id, &new_rowid.to_string(), text, metadata],
            )
            .map_err(|e| StoreError::Query(e.to_string()))?;
        Ok(())
    }

    /// KNN search — k hit gần nhất, score = 1/(1+distance).
    pub fn vec_search(&self, query: &[f32], k: usize) -> Result<Vec<VecHit>, StoreError> {
        ensure_registered();
        let q_json = format!(
            "[{}]",
            query
                .iter()
                .map(|v| format!("{v}"))
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut stmt = self
            .db
            .prepare(
                "SELECT d.id, d.text, d.metadata, 1.0 / (1.0 + v.distance) AS score \
                 FROM memories_vec v JOIN memories_doc d ON d.rowid_ = v.rowid \
                 WHERE embedding MATCH ?1 AND k = ?2",
            )
            .map_err(|e| StoreError::Query(e.to_string()))?;
        let rows = stmt
            .query_map(rusqlite::params![q_json, k as i64], |row| {
                Ok(VecHit {
                    id: row.get(0)?,
                    text: row.get(1)?,
                    metadata: row.get(2)?,
                    score: row.get(3)?,
                })
            })
            .map_err(|e| StoreError::Query(e.to_string()))?;
        let mut hits = Vec::new();
        for row in rows {
            hits.push(row.map_err(|e| StoreError::Query(e.to_string()))?);
        }
        Ok(hits)
    }

    pub fn vec_delete(&self, id: &str) -> Result<(), StoreError> {
        let row: Option<i64> = self
            .db
            .query_row("SELECT rowid_ FROM memories_doc WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| StoreError::Query(e.to_string()))?;
        if let Some(old) = row {
            self.db
                .execute("DELETE FROM memories_vec WHERE rowid = ?1", [old])
                .map_err(|e| StoreError::Query(e.to_string()))?;
            self.db
                .execute("DELETE FROM memories_doc WHERE id = ?1", [id])
                .map_err(|e| StoreError::Query(e.to_string()))?;
        }
        Ok(())
    }

    pub fn vec_count(&self) -> Result<usize, StoreError> {
        let n: i64 = self
            .db
            .query_row("SELECT COUNT(*) FROM memories_doc", [], |r| r.get(0))
            .map_err(|e| StoreError::Query(e.to_string()))?;
        Ok(n as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> KvStore {
        KvStore::open(":memory:").unwrap()
    }

    #[test]
    fn vec0_roundtrip() {
        let mut s = store();
        s.vec_ensure_schema(4).unwrap();
        s.vec_store("m1", "hello world", &[0.1, 0.2, 0.3, 0.4], "{}")
            .unwrap();
        let hits = s.vec_search(&[0.1, 0.2, 0.3, 0.4], 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "m1");
        assert!(hits[0].score > 0.99);
    }

    #[test]
    fn knn_ranking() {
        let mut s = store();
        s.vec_ensure_schema(4).unwrap();
        s.vec_store("near", "near doc", &[0.1, 0.2, 0.3, 0.4], "{}")
            .unwrap();
        s.vec_store("far", "far doc", &[0.9, 0.9, 0.9, 0.9], "{}")
            .unwrap();
        let hits = s.vec_search(&[0.1, 0.2, 0.3, 0.4], 2).unwrap();
        assert_eq!(hits[0].id, "near");
        assert_eq!(hits[1].id, "far");
    }

    #[test]
    fn upsert_overwrites() {
        let mut s = store();
        s.vec_ensure_schema(4).unwrap();
        s.vec_store("m1", "v1", &[0.1, 0.2, 0.3, 0.4], "{}")
            .unwrap();
        s.vec_store("m1", "v2", &[0.2, 0.3, 0.4, 0.5], "{}")
            .unwrap();
        assert_eq!(s.vec_count().unwrap(), 1);
        let hits = s.vec_search(&[0.2, 0.3, 0.4, 0.5], 1).unwrap();
        assert_eq!(hits[0].text, "v2");
    }

    #[test]
    fn delete_removes_hit() {
        let mut s = store();
        s.vec_ensure_schema(4).unwrap();
        s.vec_store("m1", "x", &[0.1, 0.2, 0.3, 0.4], "{}").unwrap();
        s.vec_delete("m1").unwrap();
        assert_eq!(s.vec_count().unwrap(), 0);
        assert!(s.vec_search(&[0.1, 0.2, 0.3, 0.4], 1).unwrap().is_empty());
    }
}
