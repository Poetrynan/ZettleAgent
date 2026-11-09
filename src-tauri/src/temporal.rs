use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemporalFact {
    pub id: i64,
    pub note_path: String,
    pub fact_content: String,
    pub valid_from: String,
    pub valid_to: Option<String>,
    pub superseded_by: Option<i64>,
    pub created_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEvent {
    pub id: i64,
    pub note_path: String,
    pub event_type: String,
    pub event_timestamp: String,
    pub event_details: Option<String>,
    pub old_fact_id: Option<i64>,
    pub new_fact_id: Option<i64>,
}

/// Insert a new fact into fact_history
pub fn insert_fact(
    conn: &Connection,
    note_path: &str,
    fact_content: &str,
    created_by: &str,
) -> anyhow::Result<i64> {
    conn.execute(
        "INSERT INTO fact_history (note_path, fact_content, created_by) VALUES (?1, ?2, ?3)",
        rusqlite::params![note_path, fact_content, created_by],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Invalidate an existing fact (set valid_to and superseded_by)
pub fn invalidate_fact(
    conn: &Connection,
    fact_id: i64,
    superseded_by: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE fact_history SET valid_to = datetime('now'), superseded_by = ?1 WHERE id = ?2",
        rusqlite::params![superseded_by, fact_id],
    )?;
    Ok(())
}

/// Record a timeline event
pub fn record_event(
    conn: &Connection,
    note_path: &str,
    event_type: &str,
    event_details: Option<&str>,
    old_fact_id: Option<i64>,
    new_fact_id: Option<i64>,
) -> anyhow::Result<i64> {
    conn.execute(
        "INSERT INTO knowledge_timeline (note_path, event_type, event_details, old_fact_id, new_fact_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![note_path, event_type, event_details, old_fact_id, new_fact_id],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Get all active facts for a note (valid_to IS NULL)
pub fn get_active_facts(conn: &Connection, note_path: &str) -> anyhow::Result<Vec<TemporalFact>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_path, fact_content, valid_from, valid_to, superseded_by, created_by
         FROM fact_history WHERE note_path = ?1 AND valid_to IS NULL ORDER BY valid_from DESC",
    )?;
    let facts = stmt
        .query_map(rusqlite::params![note_path], |row| {
            Ok(TemporalFact {
                id: row.get(0)?,
                note_path: row.get(1)?,
                fact_content: row.get(2)?,
                valid_from: row.get(3)?,
                valid_to: row.get(4)?,
                superseded_by: row.get(5)?,
                created_by: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(facts)
}

/// Get full history of facts for a note (including invalidated ones)
pub fn get_fact_history(conn: &Connection, note_path: &str) -> anyhow::Result<Vec<TemporalFact>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_path, fact_content, valid_from, valid_to, superseded_by, created_by
         FROM fact_history WHERE note_path = ?1 ORDER BY valid_from DESC",
    )?;
    let facts = stmt
        .query_map(rusqlite::params![note_path], |row| {
            Ok(TemporalFact {
                id: row.get(0)?,
                note_path: row.get(1)?,
                fact_content: row.get(2)?,
                valid_from: row.get(3)?,
                valid_to: row.get(4)?,
                superseded_by: row.get(5)?,
                created_by: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(facts)
}

/// Get timeline events for a note
pub fn get_timeline(conn: &Connection, note_path: &str) -> anyhow::Result<Vec<TimelineEvent>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_path, event_type, event_timestamp, event_details, old_fact_id, new_fact_id
         FROM knowledge_timeline WHERE note_path = ?1 ORDER BY event_timestamp DESC",
    )?;
    let events = stmt
        .query_map(rusqlite::params![note_path], |row| {
            Ok(TimelineEvent {
                id: row.get(0)?,
                note_path: row.get(1)?,
                event_type: row.get(2)?,
                event_timestamp: row.get(3)?,
                event_details: row.get(4)?,
                old_fact_id: row.get(5)?,
                new_fact_id: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(events)
}

/// Get timeline events for all notes within a time range
pub fn get_timeline_range(
    conn: &Connection,
    start: &str,
    end: &str,
) -> anyhow::Result<Vec<TimelineEvent>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_path, event_type, event_timestamp, event_details, old_fact_id, new_fact_id
         FROM knowledge_timeline
         WHERE julianday(event_timestamp) >= julianday(?1)
           AND julianday(event_timestamp) < CASE WHEN length(?2) = 10
               THEN julianday(?2, '+1 day') ELSE julianday(?2) END
         ORDER BY julianday(event_timestamp) DESC, id DESC",
    )?;
    let events = stmt
        .query_map(rusqlite::params![start, end], |row| {
            Ok(TimelineEvent {
                id: row.get(0)?,
                note_path: row.get(1)?,
                event_type: row.get(2)?,
                event_timestamp: row.get(3)?,
                event_details: row.get(4)?,
                old_fact_id: row.get(5)?,
                new_fact_id: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(events)
}

#[cfg(test)]
mod range_tests {
    use super::*;

    #[test]
    fn range_accepts_iso_bounds_and_includes_the_entire_end_date() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE knowledge_timeline (id INTEGER PRIMARY KEY, note_path TEXT, event_type TEXT, event_timestamp TEXT, event_details TEXT, old_fact_id INTEGER, new_fact_id INTEGER);
            INSERT INTO knowledge_timeline (id,note_path,event_type,event_timestamp) VALUES
            (1,'a.md','updated','2026-11-09 08:00:00'),
            (2,'b.md','updated','2026-11-09T17:00:00+08:00'),
            (3,'c.md','updated','2026-11-10 00:00:00');").unwrap();
        let iso = get_timeline_range(&conn, "2026-11-09T00:00:00Z", "2026-11-09T23:59:59Z").unwrap();
        assert_eq!(iso.iter().map(|e| e.id).collect::<Vec<_>>(), vec![2,1]);
        let date = get_timeline_range(&conn, "2026-11-09", "2026-11-09").unwrap();
        assert_eq!(date.len(), 2);
    }
}
