//! A small pool of extra SQLite connections for read-heavy UI commands.
//!
//! ## Why
//! Every command used to share `AppState.db`, one `Mutex<Connection>`. Long jobs
//! on it (a full `sync_vault`, the watcher's batch transaction, semantic-edge
//! rebuilds, agent tool calls) blocked unrelated quick reads such as search,
//! backlinks or the inbox badge for their whole duration, even though the
//! database runs in WAL mode, where readers never wait for a writer.
//!
//! Each connection here has its own lock, so a read command only waits for
//! another *read* on the same slot, never for the writer. Under WAL a reader
//! sees the last committed snapshot: while a long sync transaction is open, a
//! search returns the pre-sync state instead of freezing the UI.
//!
//! ## Rules
//! - Only commands that do **no writes** may use the pool. The connections are
//!   opened with `PRAGMA query_only = ON`, so a write slipped in by mistake fails
//!   loudly in testing rather than racing the main writer.
//! - Writes stay on `AppState.db`, which keeps SQLite's single-writer model and
//!   all existing transaction code unchanged.
//! - `setup_database_schema` must already have run on the main connection: the
//!   pool never creates or migrates schema.

use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// Enough for the UI's concurrent reads (search + side panels + badge polling)
/// without holding many file handles open.
pub const DEFAULT_READERS: usize = 4;

pub struct ReadPool {
    conns: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl ReadPool {
    /// Open `size` read-only connections to the database at `db_path`.
    pub fn open(db_path: &Path, size: usize) -> anyhow::Result<Self> {
        let size = size.max(1);
        let mut conns = Vec::with_capacity(size);
        for _ in 0..size {
            conns.push(Mutex::new(open_reader(db_path)?));
        }
        Ok(Self { conns, next: AtomicUsize::new(0) })
    }

    /// Borrow a connection. Prefers a free slot; if every slot is busy, waits on
    /// the next one in round-robin order.
    pub fn get(&self) -> Result<MutexGuard<'_, Connection>, PoisonError<MutexGuard<'_, Connection>>> {
        let n = self.conns.len();
        let start = self.next.fetch_add(1, Ordering::Relaxed) % n;
        for i in 0..n {
            if let Ok(guard) = self.conns[(start + i) % n].try_lock() {
                return Ok(guard);
            }
        }
        self.conns[start].lock()
    }

    pub fn len(&self) -> usize {
        self.conns.len()
    }
}

fn open_reader(db_path: &Path) -> anyhow::Result<Connection> {
    // READ_WRITE (not READ_ONLY) on purpose: a read-only handle cannot create the
    // WAL `-shm` index if it is missing, and fails outright on some setups.
    // `query_only` below is what actually forbids writes.
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
    )?;
    conn.execute_batch(
        "PRAGMA busy_timeout = 5000;
         PRAGMA foreign_keys = ON;
         PRAGMA query_only = ON;",
    )?;
    // Same per-connection SQL functions as the main connection, so any query
    // shape that works there also works here.
    crate::db::cjk::register_functions(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (std::path::PathBuf, Connection) {
        crate::db::register_sqlite_vec();
        let dir = std::env::temp_dir().join(format!("zettel-readpool-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let conn = Connection::open(&path).unwrap();
        crate::db::schema::setup_database_schema(&conn).unwrap();
        (path, conn)
    }

    #[test]
    fn readers_see_committed_writes_and_reject_writes() {
        let (path, writer) = temp_db();
        writer.execute("INSERT INTO files (path, hash) VALUES ('a.md', 'h')", []).unwrap();
        writer
            .execute("INSERT INTO chunks (file_path, chunk_index, content) VALUES ('a.md', 0, '知识图谱')", [])
            .unwrap();

        let pool = ReadPool::open(&path, 2).unwrap();
        let r = pool.get().unwrap();
        let hits = crate::db::search::full_text_search(&r, "知识图谱", 5).unwrap();
        assert_eq!(hits.len(), 1, "reader must see committed rows and the CJK index");

        let err = r.execute("DELETE FROM files", []);
        assert!(err.is_err(), "pool connections must be query_only");
    }

    #[test]
    fn read_is_not_blocked_by_an_open_write_transaction() {
        let (path, mut writer) = temp_db();
        writer.execute("INSERT INTO files (path, hash) VALUES ('a.md', 'h')", []).unwrap();
        let pool = ReadPool::open(&path, 1).unwrap();

        let tx = writer.transaction().unwrap();
        tx.execute("INSERT INTO files (path, hash) VALUES ('b.md', 'h')", []).unwrap();

        // WAL: the reader proceeds immediately and sees the pre-transaction snapshot.
        let n: i64 = pool.get().unwrap().query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        tx.commit().unwrap();
        let n: i64 = pool.get().unwrap().query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn busy_slots_are_skipped() {
        let (path, _w) = temp_db();
        let pool = ReadPool::open(&path, 2).unwrap();
        let a = pool.get().unwrap();
        // Second borrow must not deadlock while the first is held.
        let b = pool.get().unwrap();
        drop((a, b));
        assert_eq!(pool.len(), 2);
    }
}
