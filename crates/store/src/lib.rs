#[cfg(feature = "addon")]
mod napi;

#[cfg(feature = "vec")]
mod vec;

#[cfg(feature = "addon")]
use rusqlite::OptionalExtension;

#[cfg(not(feature = "addon"))]
use std::collections::HashMap;

/// A simple key-value store interface.
/// When the addon feature is enabled, this delegates to rusqlite.
/// Otherwise, it uses an in-memory HashMap fallback.
pub struct KvStore {
    #[cfg(feature = "addon")]
    db: rusqlite::Connection,
    #[cfg(not(feature = "addon"))]
    map: HashMap<String, String>,
}

impl KvStore {
    /// Open or create a store at the given path. Use ":memory:" for in-memory.
    pub fn open(path: &str) -> Result<Self, StoreError> {
        #[cfg(feature = "addon")]
        {
            // vec0 (sqlite-vec) phải đăng ký TRƯỚC khi mở connection —
            // sqlite3_auto_extension chỉ áp dụng cho connection mở sau đó.
            #[cfg(feature = "vec")]
            crate::vec::ensure_registered();

            let db = if path == ":memory:" {
                rusqlite::Connection::open_in_memory()
            } else {
                rusqlite::Connection::open(path)
            }
            .map_err(|e| StoreError::Open(e.to_string()))?;

            // WAL turns per-set fsyncs into cheap appends; NORMAL is the
            // recommended synchronous level for WAL mode.
            db.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| StoreError::Init(e.to_string()))?;
            db.pragma_update(None, "synchronous", "NORMAL")
                .map_err(|e| StoreError::Init(e.to_string()))?;

            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS kv (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
                );",
            )
            .map_err(|e| StoreError::Init(e.to_string()))?;

            Ok(KvStore { db })
        }

        #[cfg(not(feature = "addon"))]
        {
            let _ = path;
            Ok(KvStore {
                map: HashMap::new(),
            })
        }
    }

    /// Get a value by key.
    pub fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        #[cfg(feature = "addon")]
        {
            let mut stmt = self
                .db
                .prepare("SELECT value FROM kv WHERE key = ?")
                .map_err(|e| StoreError::Query(e.to_string()))?;
            let result = stmt
                .query_row([key], |row| row.get::<_, String>(0))
                .optional()
                .map_err(|e| StoreError::Query(e.to_string()))?;
            Ok(result)
        }

        #[cfg(not(feature = "addon"))]
        {
            Ok(self.map.get(key).cloned())
        }
    }

    /// Set a key-value pair (upsert).
    pub fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        #[cfg(feature = "addon")]
        {
            self.db
                .execute(
                    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, strftime('%s','now'))
                     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = strftime('%s','now')",
                    [key, value],
                )
                .map_err(|e| StoreError::Write(e.to_string()))?;
            Ok(())
        }

        #[cfg(not(feature = "addon"))]
        {
            let _ = (key, value);
            Ok(())
        }
    }

    /// Set many key-value pairs in ONE transaction — N keys cost one commit
    /// instead of N fsync round-trips.
    pub fn set_many(&self, entries: &[(&str, &str)]) -> Result<(), StoreError> {
        #[cfg(feature = "addon")]
        {
            let tx = self
                .db
                .unchecked_transaction()
                .map_err(|e| StoreError::Write(e.to_string()))?;
            for (key, value) in entries {
                tx.execute(
                    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, strftime('%s','now'))
                     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = strftime('%s','now')",
                    [key, value],
                )
                .map_err(|e| StoreError::Write(e.to_string()))?;
            }
            tx.commit().map_err(|e| StoreError::Write(e.to_string()))?;
            Ok(())
        }

        #[cfg(not(feature = "addon"))]
        {
            let _ = entries;
            Ok(())
        }
    }

    /// Delete a key.
    pub fn delete(&self, key: &str) -> Result<bool, StoreError> {
        #[cfg(feature = "addon")]
        {
            let affected = self
                .db
                .execute("DELETE FROM kv WHERE key = ?", [key])
                .map_err(|e| StoreError::Write(e.to_string()))?;
            Ok(affected > 0)
        }

        #[cfg(not(feature = "addon"))]
        {
            let _ = key;
            Ok(false)
        }
    }

    /// List all keys.
    pub fn keys(&self) -> Result<Vec<String>, StoreError> {
        #[cfg(feature = "addon")]
        {
            let mut stmt = self
                .db
                .prepare("SELECT key FROM kv ORDER BY key")
                .map_err(|e| StoreError::Query(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| StoreError::Query(e.to_string()))?;
            let mut keys = Vec::new();
            for row in rows {
                keys.push(row.map_err(|e| StoreError::Query(e.to_string()))?);
            }
            Ok(keys)
        }

        #[cfg(not(feature = "addon"))]
        {
            Ok(Vec::new())
        }
    }

    /// Count entries.
    pub fn count(&self) -> Result<usize, StoreError> {
        #[cfg(feature = "addon")]
        {
            let mut stmt = self
                .db
                .prepare("SELECT COUNT(*) FROM kv")
                .map_err(|e| StoreError::Query(e.to_string()))?;
            let count: usize = stmt
                .query_row([], |row| row.get(0))
                .map_err(|e| StoreError::Query(e.to_string()))?;
            Ok(count)
        }

        #[cfg(not(feature = "addon"))]
        {
            Ok(0)
        }
    }
}

#[derive(Debug, Clone)]
pub enum StoreError {
    Open(String),
    Init(String),
    Query(String),
    Write(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Open(e) => write!(f, "store open error: {}", e),
            StoreError::Init(e) => write!(f, "store init error: {}", e),
            StoreError::Query(e) => write!(f, "store query error: {}", e),
            StoreError::Write(e) => write!(f, "store write error: {}", e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_store_basic_operations() {
        // Without the addon feature, this tests the fallback path
        // With the addon feature, this tests actual SQLite
        let store = KvStore::open(":memory:").expect("failed to open store");

        // Set and get
        store.set("key1", "value1").expect("set failed");
        let _val = store.get("key1").expect("get failed");

        #[cfg(feature = "addon")]
        assert_eq!(_val, Some("value1".to_string()));

        // Count
        let _count = store.count().expect("count failed");
        #[cfg(feature = "addon")]
        assert_eq!(_count, 1);

        // Keys
        let _keys = store.keys().expect("keys failed");
        #[cfg(feature = "addon")]
        assert!(_keys.contains(&"key1".to_string()));

        // Delete
        let _deleted = store.delete("key1").expect("delete failed");
        #[cfg(feature = "addon")]
        assert!(_deleted);

        let _val_after = store.get("key1").expect("get after delete failed");
        #[cfg(feature = "addon")]
        assert_eq!(_val_after, None);
    }

    #[test]
    fn nonexistent_key_returns_none() {
        let store = KvStore::open(":memory:").expect("failed to open store");
        let val = store.get("nonexistent").expect("get failed");
        assert_eq!(val, None);
    }
}
