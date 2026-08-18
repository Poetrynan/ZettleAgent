//! Persistence for the spaced-repetition deck: `review_cards` + `review_log`.
//!
//! [`crate::fsrs`] owns the arithmetic and knows nothing about SQLite; this
//! module owns the SQL and knows nothing about Tauri. Follows the
//! `db::memory_store` split — commands stay thin, domain logic is testable
//! against an in-memory `Connection`.
//!
//! ## Daily caps are part of the store, not the UI
//!
//! A vault of 5000 notes added to the deck at once produces a 5000-card queue on
//! day one, which a user reads as "this feature is broken". Anki solved this
//! twenty years ago with per-day limits, so the queue query applies them here,
//! server-side, rather than trusting every caller to slice correctly.

use rusqlite::{params, Connection, OptionalExtension};

use crate::fsrs::{self, Card, FsrsConfig, Grade, State};

/// Chars (not bytes) of note text shown as the queue preview.
const PREVIEW_CHARS: usize = 120;

/// Hard ceiling on how many rows the queue query may return regardless of the
/// caller's `limit`, so a bad argument cannot turn a session start into a
/// full-table scan.
const QUEUE_HARD_LIMIT: usize = 500;

/// How far ahead [`stats`] projects the workload.
pub const FORECAST_DAYS: i64 = 7;

const MS_PER_DAY: i64 = 86_400_000;

// ── Config persistence + process-global active config ───────────────────────
//
// Same shape as `db::search::rerank`: `app_settings` as the durable store, a
// `OnceLock<Mutex<_>>` as the read cache, one `restore_config` at startup, and
// deliberately asymmetric validation — the setter command rejects out-of-range
// values so a bad setting is visible, while `load_config` clamps so a row
// written by another build can never break the queue.

pub const DESIRED_RETENTION_KEY: &str = "fsrs_desired_retention";
pub const MAXIMUM_INTERVAL_KEY: &str = "fsrs_maximum_interval_days";
pub const LEARNING_STEPS_KEY: &str = "fsrs_learning_steps";
pub const ENABLE_FUZZ_KEY: &str = "fsrs_enable_fuzz";
pub const NEW_PER_DAY_KEY: &str = "fsrs_new_per_day";
pub const REVIEWS_PER_DAY_KEY: &str = "fsrs_reviews_per_day";

fn config_slot() -> &'static std::sync::Mutex<FsrsConfig> {
    static SLOT: std::sync::OnceLock<std::sync::Mutex<FsrsConfig>> = std::sync::OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(FsrsConfig::default()))
}

/// The scheduling config in force for this process. A poisoned lock degrades to
/// the default rather than panicking: a failed review is recoverable, a crashed
/// app is not.
pub fn active_config() -> FsrsConfig {
    config_slot()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/// Overwrite the in-memory config. Persistence is the caller's job.
pub fn store_config(config: FsrsConfig) {
    if let Ok(mut g) = config_slot().lock() {
        *g = config;
    }
}

/// Read the persisted config, falling back per field to the default and clamping
/// the result. Missing rows are the normal case on a fresh vault.
pub fn load_config(conn: &Connection) -> FsrsConfig {
    let get = |key: &str| crate::db::schema::get_setting(conn, key).ok().flatten();
    let mut config = FsrsConfig::default();
    if let Some(v) = get(DESIRED_RETENTION_KEY).and_then(|v| v.trim().parse::<f64>().ok()) {
        config.desired_retention = v;
    }
    if let Some(v) = get(MAXIMUM_INTERVAL_KEY).and_then(|v| v.trim().parse::<i64>().ok()) {
        config.maximum_interval_days = v;
    }
    if let Some(v) = get(LEARNING_STEPS_KEY) {
        // Comma-separated minutes rather than JSON: one row, human-readable in a
        // DB browser, and a malformed entry drops that step instead of the list.
        let steps: Vec<u32> = v
            .split(',')
            .filter_map(|part| part.trim().parse::<u32>().ok())
            .collect();
        if !steps.is_empty() {
            config.learning_steps = steps;
        }
    }
    if let Some(v) = get(ENABLE_FUZZ_KEY) {
        config.enable_fuzz = v.trim() != "false";
    }
    if let Some(v) = get(NEW_PER_DAY_KEY).and_then(|v| v.trim().parse::<i64>().ok()) {
        config.new_per_day = v;
    }
    if let Some(v) = get(REVIEWS_PER_DAY_KEY).and_then(|v| v.trim().parse::<i64>().ok()) {
        config.reviews_per_day = v;
    }
    config.clamped()
}

/// Write every field, so a later [`load_config`] never mixes a new retention
/// target with a stale interval cap.
pub fn save_config(conn: &Connection, config: &FsrsConfig) -> anyhow::Result<()> {
    let set = |key: &str, value: String| crate::db::schema::set_setting(conn, key, &value);
    set(DESIRED_RETENTION_KEY, config.desired_retention.to_string())?;
    set(MAXIMUM_INTERVAL_KEY, config.maximum_interval_days.to_string())?;
    set(
        LEARNING_STEPS_KEY,
        config
            .learning_steps
            .iter()
            .map(|m| m.to_string())
            .collect::<Vec<_>>()
            .join(","),
    )?;
    set(ENABLE_FUZZ_KEY, config.enable_fuzz.to_string())?;
    set(NEW_PER_DAY_KEY, config.new_per_day.to_string())?;
    set(REVIEWS_PER_DAY_KEY, config.reviews_per_day.to_string())?;
    Ok(())
}

/// Restore the persisted config into process state at startup. Never fails.
pub fn restore_config(conn: &Connection) {
    let config = load_config(conn);
    log::info!(
        "[fsrs] retention={:.2} max_interval={}d new/day={} reviews/day={}",
        config.desired_retention,
        config.maximum_interval_days,
        config.new_per_day,
        config.reviews_per_day
    );
    store_config(config);
}

// ── Card rows ───────────────────────────────────────────────────────────────

/// Load one card. `Ok(None)` means the note is not in the deck.
pub fn get_card(conn: &Connection, file_path: &str) -> rusqlite::Result<Option<Card>> {
    conn.query_row(
        "SELECT file_path, stability, difficulty, due_at_ms, last_review_ms, reps, lapses, state
         FROM review_cards WHERE file_path = ?1",
        params![file_path],
        row_to_card,
    )
    .optional()
}

fn row_to_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<Card> {
    let state: String = row.get(7)?;
    Ok(Card {
        key: row.get(0)?,
        stability: row.get(1)?,
        difficulty: row.get(2)?,
        due_at_ms: row.get(3)?,
        last_review_ms: row.get(4)?,
        // Not persisted: both are properties of the *transition* and are
        // recomputed by `fsrs::review`. The durable copy lives in `review_log`.
        elapsed_days: 0.0,
        scheduled_days: 0.0,
        reps: row.get::<_, i64>(5)?.max(0) as u32,
        lapses: row.get::<_, i64>(6)?.max(0) as u32,
        state: State::from_str_lenient(&state),
    })
}

/// Whether a note is in the deck, and whether it is suspended.
pub fn card_status(conn: &Connection, file_path: &str) -> rusqlite::Result<Option<bool>> {
    conn.query_row(
        "SELECT suspended FROM review_cards WHERE file_path = ?1",
        params![file_path],
        |row| Ok(row.get::<_, i64>(0)? != 0),
    )
    .optional()
}

/// Write the post-review state back. `suspended` is untouched: it is the user's
/// flag, not the scheduler's.
pub fn upsert_card(conn: &Connection, card: &Card, now_ms: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO review_cards
            (file_path, stability, difficulty, due_at_ms, last_review_ms, reps, lapses, state, suspended, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)
         ON CONFLICT(file_path) DO UPDATE SET
            stability = ?2, difficulty = ?3, due_at_ms = ?4,
            last_review_ms = ?5, reps = ?6, lapses = ?7, state = ?8",
        params![
            card.key,
            card.stability,
            card.difficulty,
            card.due_at_ms,
            card.last_review_ms,
            card.reps as i64,
            card.lapses as i64,
            card.state.as_str(),
            now_ms,
        ],
    )?;
    Ok(())
}

/// Add notes to the deck as `New` cards, due now.
///
/// `INSERT OR IGNORE`, so re-adding a note the user is already studying is a
/// no-op instead of wiping months of scheduling state. Returns how many rows
/// were actually created. Paths absent from `files` are skipped rather than
/// failing the batch — the foreign key would reject them, and one unsynced path
/// should not lose the other 49 in a bulk add.
pub fn add_cards(conn: &Connection, file_paths: &[String], now_ms: i64) -> rusqlite::Result<usize> {
    let mut added = 0usize;
    for path in file_paths {
        let known: bool = conn
            .query_row(
                "SELECT 1 FROM files WHERE path = ?1",
                params![path],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !known {
            log::warn!("[fsrs] skipping add for unsynced path: {}", path);
            continue;
        }
        added += conn.execute(
            "INSERT OR IGNORE INTO review_cards
                (file_path, stability, difficulty, due_at_ms, last_review_ms, reps, lapses, state, suspended, created_at_ms)
             VALUES (?1, 0, 0, ?2, NULL, 0, 0, 'new', 0, ?2)",
            params![path, now_ms],
        )?;
    }
    Ok(added)
}

/// Remove a note from the deck. The `review_log` history is intentionally left
/// behind — see the schema comment on why it has no cascading FK.
pub fn remove_card(conn: &Connection, file_path: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "DELETE FROM review_cards WHERE file_path = ?1",
        params![file_path],
    )?;
    Ok(n > 0)
}

pub fn set_suspended(conn: &Connection, file_path: &str, suspended: bool) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE review_cards SET suspended = ?2 WHERE file_path = ?1",
        params![file_path, if suspended { 1 } else { 0 }],
    )?;
    Ok(n > 0)
}

/// Append the history row for one grade. Called with the card as it was *before*
/// and *after* the transition; both are stored so a future parameter optimiser
/// can replay the session without re-deriving state.
pub fn append_log(
    conn: &Connection,
    before: &Card,
    after: &Card,
    grade: Grade,
    reviewed_at_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO review_log
            (file_path, grade, reviewed_at_ms, elapsed_days, scheduled_days,
             stability_before, stability_after, difficulty_before, difficulty_after,
             state_before, state_after)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            after.key,
            grade.as_i64(),
            reviewed_at_ms,
            after.elapsed_days,
            after.scheduled_days,
            before.stability,
            after.stability,
            before.difficulty,
            after.difficulty,
            before.state.as_str(),
            after.state.as_str(),
        ],
    )?;
    Ok(())
}

// ── Queue ───────────────────────────────────────────────────────────────────

/// What one grade button would do to the card in front of the user.
///
/// Computed server-side and shipped with the queue rather than fetched per
/// keypress: a reviewer needs to see "Good → 4 天" *before* committing, and
/// re-deriving FSRS in TypeScript would mean two implementations of the same
/// arithmetic drifting apart.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradePreview {
    pub grade: i64,
    /// Whole days until the card would come back. `0` for a card that stays in
    /// (re)learning, in which case read `interval_minutes` instead.
    pub interval_days: i64,
    pub interval_minutes: i64,
    pub state: State,
}

/// Run the scheduler once per grade without persisting anything.
pub fn grade_previews(card: &Card, now_ms: i64, config: &FsrsConfig) -> Vec<GradePreview> {
    [Grade::Again, Grade::Hard, Grade::Good, Grade::Easy]
        .iter()
        .map(|g| {
            let next = fsrs::review(card, *g, now_ms, config);
            let delta = (next.due_at_ms - now_ms).max(0);
            GradePreview {
                grade: g.as_i64(),
                interval_days: delta / MS_PER_DAY,
                interval_minutes: delta / 60_000,
                state: next.state,
            }
        })
        .collect()
}

/// One row in the study queue.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub file_path: String,
    pub title: String,
    /// First `PREVIEW_CHARS` **characters** of the note. Char-truncated, never
    /// byte-sliced: a byte slice through a CJK codepoint panics.
    pub preview: String,
    pub due_at_ms: i64,
    pub state: State,
    /// Whole days the card is past due. Negative values are clamped to 0 — the
    /// UI shows this as "逾期 N 天" and "overdue -3 days" is nonsense.
    pub overdue_days: i64,
    pub reps: u32,
    pub lapses: u32,
    /// The four buttons' outcomes, in `Again, Hard, Good, Easy` order.
    pub grade_previews: Vec<GradePreview>,
}

/// A study session's worth of cards plus the counters the UI needs to show
/// progress and to explain *why* the queue is the length it is.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQueue {
    /// Cards already learned and now due, oldest-due first.
    pub due: Vec<QueueEntry>,
    /// Never-studied cards, oldest-added first.
    pub new_cards: Vec<QueueEntry>,
    /// Cards due right now, ignoring the daily cap. Lets the UI say
    /// "200 of 743 due today" instead of silently hiding 543 cards.
    pub due_total: i64,
    pub new_total: i64,
    pub reviews_done_today: i64,
    pub new_done_today: i64,
    /// What is left of each cap after today's work.
    pub reviews_remaining_today: i64,
    pub new_remaining_today: i64,
}

/// Epoch ms of the local midnight at or before `now_ms`.
///
/// Local, not UTC: "cards done today" has to mean the user's today, or a user in
/// UTC+8 sees their counters reset at 08:00.
pub fn local_day_start_ms(now_ms: i64) -> i64 {
    use chrono::{Local, TimeZone};
    let fallback = now_ms - now_ms.rem_euclid(MS_PER_DAY);
    let Some(dt) = Local.timestamp_millis_opt(now_ms).single() else {
        return fallback;
    };
    dt.date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| Local.from_local_datetime(&naive).earliest())
        .map(|start| start.timestamp_millis())
        .unwrap_or(fallback)
}

/// Truncate to `PREVIEW_CHARS` characters, collapsing whitespace.
///
/// `chars().take(n)` rather than `&s[..n]`: this repo has already shipped six
/// panics from byte-slicing user text, all of them in CJK notes.
fn preview_of(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(PREVIEW_CHARS).collect();
    if flat.chars().count() > PREVIEW_CHARS {
        out.push('…');
    }
    out
}

/// Build the queue, honouring both daily caps.
///
/// `limit` bounds each list independently and is itself capped at
/// [`QUEUE_HARD_LIMIT`]; a session is a handful of cards at a time, and the
/// frontend re-fetches.
pub fn queue(
    conn: &Connection,
    limit: usize,
    now_ms: i64,
    config: &FsrsConfig,
) -> rusqlite::Result<ReviewQueue> {
    let day_start = local_day_start_ms(now_ms);
    let (new_done_today, reviews_done_today) = counts_today(conn, day_start)?;

    let new_remaining = (config.new_per_day - new_done_today).max(0);
    let reviews_remaining = (config.reviews_per_day - reviews_done_today).max(0);

    let bound = limit.clamp(1, QUEUE_HARD_LIMIT) as i64;
    let due_take = bound.min(reviews_remaining);
    let new_take = bound.min(new_remaining);

    // Two queries rather than one UNION: the orderings differ (due date vs.
    // insertion order) and each has its own index.
    let due = if due_take > 0 {
        select_entries(
            conn,
            "SELECT file_path, stability, difficulty, due_at_ms, last_review_ms, reps, lapses, state
             FROM review_cards
             WHERE suspended = 0 AND state != 'new' AND due_at_ms <= ?1
             ORDER BY due_at_ms ASC
             LIMIT ?2",
            params![now_ms, due_take],
            now_ms,
            config,
        )?
    } else {
        Vec::new()
    };

    let new_cards = if new_take > 0 {
        select_entries(
            conn,
            "SELECT file_path, stability, difficulty, due_at_ms, last_review_ms, reps, lapses, state
             FROM review_cards
             WHERE suspended = 0 AND state = 'new'
             ORDER BY created_at_ms ASC
             LIMIT ?1",
            params![new_take],
            now_ms,
            config,
        )?
    } else {
        Vec::new()
    };

    let due_total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_cards
         WHERE suspended = 0 AND state != 'new' AND due_at_ms <= ?1",
        params![now_ms],
        |row| row.get(0),
    )?;
    let new_total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_cards WHERE suspended = 0 AND state = 'new'",
        [],
        |row| row.get(0),
    )?;

    Ok(ReviewQueue {
        due,
        new_cards,
        due_total,
        new_total,
        reviews_done_today,
        new_done_today,
        reviews_remaining_today: reviews_remaining,
        new_remaining_today: new_remaining,
    })
}

/// `(new cards introduced today, reviews of already-learned cards today)`.
///
/// Split on `state_before`: a card graded out of `new` counts against the new
/// allowance, everything else against the review allowance. This is Anki's
/// accounting, and it matters because otherwise introducing 20 new cards would
/// consume 20 of the 200 review slots.
fn counts_today(conn: &Connection, day_start_ms: i64) -> rusqlite::Result<(i64, i64)> {
    let new_done: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT file_path) FROM review_log
         WHERE reviewed_at_ms >= ?1 AND state_before = 'new'",
        params![day_start_ms],
        |row| row.get(0),
    )?;
    let reviews_done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_log
         WHERE reviewed_at_ms >= ?1 AND state_before != 'new'",
        params![day_start_ms],
        |row| row.get(0),
    )?;
    Ok((new_done, reviews_done))
}

/// Run a queue query and decorate each row with title + preview.
///
/// Title and preview come from `files` / `chunks` rather than from disk: the
/// queue is opened interactively and reading N files synchronously would show up
/// as lag. `chunks` is kept in sync by `db::sync` on every edit.
fn select_entries(
    conn: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
    now_ms: i64,
    config: &FsrsConfig,
) -> rusqlite::Result<Vec<QueueEntry>> {
    let mut stmt = conn.prepare(sql)?;
    let cards: Vec<Card> = stmt
        .query_map(args, row_to_card)?
        .filter_map(|r| r.ok())
        .collect();

    let mut out = Vec::with_capacity(cards.len());
    for card in cards {
        let title: Option<String> = conn
            .query_row(
                "SELECT title FROM files WHERE path = ?1",
                params![&card.key],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let body: Option<String> = conn
            .query_row(
                "SELECT content FROM chunks WHERE file_path = ?1 ORDER BY chunk_index LIMIT 1",
                params![&card.key],
                |row| row.get(0),
            )
            .optional()?;

        out.push(QueueEntry {
            title: title.unwrap_or_else(|| file_name_of(&card.key)),
            preview: body.as_deref().map(preview_of).unwrap_or_default(),
            overdue_days: ((now_ms - card.due_at_ms) / MS_PER_DAY).max(0),
            due_at_ms: card.due_at_ms,
            state: card.state,
            reps: card.reps,
            lapses: card.lapses,
            grade_previews: grade_previews(&card, now_ms, config),
            file_path: card.key,
        });
    }
    Ok(out)
}

/// Basename without the `.md` extension, for notes with no indexed title.
fn file_name_of(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md")
        .to_string()
}

// ── Stats ───────────────────────────────────────────────────────────────────

/// Cards becoming due on one future day, relative to today.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastDay {
    /// 0 = today, 1 = tomorrow.
    pub day_offset: i64,
    pub count: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStats {
    pub total_cards: i64,
    pub new_count: i64,
    pub learning_count: i64,
    pub review_count: i64,
    pub relearning_count: i64,
    pub suspended_count: i64,
    pub due_today: i64,
    /// One entry per day for the next [`FORECAST_DAYS`] days, index 0 = today.
    pub forecast: Vec<ForecastDay>,
    /// True retention: the share of *mature* reviews (cards that were already in
    /// `review` state) that were not lapses. Learning-step repeats are excluded
    /// because they are drills, not retention measurements, and including them
    /// makes the number look far worse than the user's actual memory.
    /// `None` until there is at least one mature review to divide by.
    pub retention_rate: Option<f64>,
    pub reviews_today: i64,
    pub total_reviews: i64,
    /// Consecutive days with at least one review, counting back from today. A
    /// day studied yesterday but not yet today still counts, so the streak does
    /// not read as broken before the user has had their morning session.
    pub streak_days: i64,
}

pub fn stats(conn: &Connection, now_ms: i64) -> rusqlite::Result<ReviewStats> {
    let count_state = |state: &str| -> rusqlite::Result<i64> {
        conn.query_row(
            "SELECT COUNT(*) FROM review_cards WHERE state = ?1 AND suspended = 0",
            params![state],
            |row| row.get(0),
        )
    };

    let total_cards: i64 =
        conn.query_row("SELECT COUNT(*) FROM review_cards", [], |row| row.get(0))?;
    let suspended_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_cards WHERE suspended = 1",
        [],
        |row| row.get(0),
    )?;
    let due_today: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_cards
         WHERE suspended = 0 AND state != 'new' AND due_at_ms <= ?1",
        params![now_ms],
        |row| row.get(0),
    )?;

    let day_start = local_day_start_ms(now_ms);
    let forecast_end = day_start + (FORECAST_DAYS + 1) * MS_PER_DAY;

    // Bucketed in Rust rather than SQL: SQLite's date functions work in UTC, and
    // "which day is this due on" has to agree with the user's calendar.
    let mut buckets = vec![0i64; FORECAST_DAYS as usize + 1];
    {
        let mut stmt = conn.prepare(
            "SELECT due_at_ms FROM review_cards
             WHERE suspended = 0 AND state != 'new' AND due_at_ms < ?1",
        )?;
        for due in stmt
            .query_map(params![forecast_end], |row| row.get::<_, i64>(0))?
            .filter_map(|r| r.ok())
        {
            // Anything already overdue is work for today.
            let offset = ((due - day_start).max(0) / MS_PER_DAY).min(FORECAST_DAYS);
            buckets[offset as usize] += 1;
        }
    }
    let forecast = buckets
        .into_iter()
        .enumerate()
        .map(|(i, count)| ForecastDay { day_offset: i as i64, count })
        .collect();

    let mature_total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_log WHERE state_before = 'review'",
        [],
        |row| row.get(0),
    )?;
    let mature_passed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_log WHERE state_before = 'review' AND grade > 1",
        [],
        |row| row.get(0),
    )?;
    let retention_rate = if mature_total > 0 {
        Some(mature_passed as f64 / mature_total as f64)
    } else {
        None
    };

    let reviews_today: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_log WHERE reviewed_at_ms >= ?1",
        params![day_start],
        |row| row.get(0),
    )?;
    let total_reviews: i64 =
        conn.query_row("SELECT COUNT(*) FROM review_log", [], |row| row.get(0))?;

    Ok(ReviewStats {
        total_cards,
        new_count: count_state("new")?,
        learning_count: count_state("learning")?,
        review_count: count_state("review")?,
        relearning_count: count_state("relearning")?,
        suspended_count,
        due_today,
        forecast,
        retention_rate,
        reviews_today,
        total_reviews,
        streak_days: streak(conn, day_start)?,
    })
}

/// Length of the current study streak in days.
///
/// Bounded to a year of history: a streak is a motivational counter, and reading
/// the whole log to prove someone studied every day since 2019 is not worth the
/// scan.
fn streak(conn: &Connection, day_start_ms: i64) -> rusqlite::Result<i64> {
    let horizon = day_start_ms - 365 * MS_PER_DAY;
    let mut stmt = conn.prepare(
        "SELECT reviewed_at_ms FROM review_log
         WHERE reviewed_at_ms >= ?1 ORDER BY reviewed_at_ms DESC",
    )?;
    let days: std::collections::BTreeSet<i64> = stmt
        .query_map(params![horizon], |row| row.get::<_, i64>(0))?
        .filter_map(|r| r.ok())
        .map(|ms| (local_day_start_ms(ms) - day_start_ms) / MS_PER_DAY)
        .collect();

    if days.is_empty() {
        return Ok(0);
    }
    // Start from today if today has a review, otherwise from yesterday.
    let mut cursor = if days.contains(&0) { 0 } else { -1 };
    if !days.contains(&cursor) {
        return Ok(0);
    }
    let mut length = 0;
    while days.contains(&cursor) {
        length += 1;
        cursor -= 1;
    }
    Ok(length)
}

// ── Grading ─────────────────────────────────────────────────────────────────

/// Apply a grade: schedule, persist, and append history in one transaction-less
/// pair of writes.
///
/// No explicit transaction: the two statements are independent, and the failure
/// mode of a half-applied grade (card moved, log row missing) degrades stats
/// rather than the schedule. Wrapping them would mean taking a write lock across
/// the whole call on a connection the watcher and scheduler also use.
///
/// A note that is not yet in the deck is added on the spot — grading is an
/// unambiguous statement of intent to study it.
pub fn grade(
    conn: &Connection,
    file_path: &str,
    grade: Grade,
    now_ms: i64,
    config: &FsrsConfig,
) -> rusqlite::Result<Card> {
    let before = match get_card(conn, file_path)? {
        Some(card) => card,
        None => Card::new(file_path, now_ms),
    };
    let after = fsrs::review(&before, grade, now_ms, config);
    upsert_card(conn, &after, now_ms)?;
    append_log(conn, &before, &after, grade, now_ms)?;
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    /// Only the tables this module touches, mirroring `schema.rs`. Keeps the test
    /// DB independent of vec0 / FTS5 extension loading.
    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, title TEXT);
             CREATE TABLE chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL
             );
             CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
             );
             CREATE TABLE review_cards (
                file_path       TEXT PRIMARY KEY,
                stability       REAL NOT NULL DEFAULT 0,
                difficulty      REAL NOT NULL DEFAULT 0,
                due_at_ms       INTEGER NOT NULL,
                last_review_ms  INTEGER,
                reps            INTEGER NOT NULL DEFAULT 0,
                lapses          INTEGER NOT NULL DEFAULT 0,
                state           TEXT NOT NULL DEFAULT 'new',
                suspended       INTEGER NOT NULL DEFAULT 0,
                created_at_ms   INTEGER NOT NULL
             );
             CREATE TABLE review_log (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path         TEXT NOT NULL,
                grade             INTEGER NOT NULL,
                reviewed_at_ms    INTEGER NOT NULL,
                elapsed_days      REAL NOT NULL DEFAULT 0,
                scheduled_days    REAL NOT NULL DEFAULT 0,
                stability_before  REAL,
                stability_after   REAL,
                difficulty_before REAL,
                difficulty_after  REAL,
                state_before      TEXT,
                state_after       TEXT
             );",
        )
        .unwrap();
        conn
    }

    fn add_note(conn: &Connection, path: &str, title: &str, body: &str) {
        conn.execute(
            "INSERT INTO files (path, hash, title) VALUES (?1, 'h', ?2)",
            params![path, title],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, content) VALUES (?1, 0, ?2)",
            params![path, body],
        )
        .unwrap();
    }

    #[test]
    fn add_cards_is_idempotent_and_skips_unsynced_paths() {
        let conn = test_db();
        add_note(&conn, "v/a.md", "A", "body a");

        let paths = vec!["v/a.md".to_string(), "v/ghost.md".to_string()];
        assert_eq!(add_cards(&conn, &paths, T0).unwrap(), 1);
        // Second add must not reset the card.
        assert_eq!(add_cards(&conn, &paths, T0 + 1000).unwrap(), 0);
        assert_eq!(card_status(&conn, "v/a.md").unwrap(), Some(false));
        assert_eq!(card_status(&conn, "v/ghost.md").unwrap(), None);
    }

    #[test]
    fn grading_persists_the_schedule_and_appends_history() {
        let conn = test_db();
        add_note(&conn, "v/a.md", "A", "body");
        let config = FsrsConfig { enable_fuzz: false, ..Default::default() };

        let after = grade(&conn, "v/a.md", Grade::Easy, T0, &config).unwrap();
        assert_eq!(after.state, State::Review);
        assert!(after.due_at_ms > T0);

        let reloaded = get_card(&conn, "v/a.md").unwrap().unwrap();
        assert_eq!(reloaded.state, State::Review);
        assert_eq!(reloaded.reps, 1);
        assert!((reloaded.stability - after.stability).abs() < 1e-9);

        let (before_state, after_state, grade_value): (String, String, i64) = conn
            .query_row(
                "SELECT state_before, state_after, grade FROM review_log",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(before_state, "new");
        assert_eq!(after_state, "review");
        assert_eq!(grade_value, 4);
    }

    #[test]
    fn queue_separates_new_from_due_and_carries_a_char_safe_preview() {
        let conn = test_db();
        // A CJK body long enough to need truncating — the case that used to panic.
        let body = "间隔重复".repeat(60);
        add_note(&conn, "v/中文笔记.md", "中文笔记", &body);
        add_note(&conn, "v/b.md", "B", "short");
        add_cards(
            &conn,
            &["v/中文笔记.md".to_string(), "v/b.md".to_string()],
            T0,
        )
        .unwrap();

        let config = FsrsConfig { enable_fuzz: false, ..Default::default() };
        let q = queue(&conn, 20, T0, &config).unwrap();
        assert_eq!(q.new_cards.len(), 2);
        assert!(q.due.is_empty());

        let cjk = q
            .new_cards
            .iter()
            .find(|e| e.file_path == "v/中文笔记.md")
            .unwrap();
        assert_eq!(cjk.preview.chars().count(), PREVIEW_CHARS + 1, "one char for the ellipsis");
        assert!(cjk.preview.ends_with('…'));

        // Graduate one card into the past and it shows up as due + overdue.
        let card = grade(&conn, "v/b.md", Grade::Easy, T0, &config).unwrap();
        let much_later = card.due_at_ms + 3 * MS_PER_DAY;
        let q = queue(&conn, 20, much_later, &config).unwrap();
        assert_eq!(q.due.len(), 1);
        assert_eq!(q.due[0].file_path, "v/b.md");
        assert_eq!(q.due[0].overdue_days, 3);
    }

    #[test]
    fn daily_caps_bound_the_queue_and_the_totals_still_show_the_backlog() {
        let conn = test_db();
        for i in 0..10 {
            let path = format!("v/n{i}.md");
            add_note(&conn, &path, &format!("N{i}"), "body");
            add_cards(&conn, &[path], T0 + i).unwrap();
        }
        let config = FsrsConfig {
            new_per_day: 3,
            enable_fuzz: false,
            ..Default::default()
        };

        let q = queue(&conn, 50, T0, &config).unwrap();
        assert_eq!(q.new_cards.len(), 3, "the cap, not the limit, should bind");
        assert_eq!(q.new_total, 10, "the backlog must stay visible");
        assert_eq!(q.new_remaining_today, 3);
        // Oldest-added first, so the ordering is stable across fetches.
        assert_eq!(q.new_cards[0].file_path, "v/n0.md");

        // Study the allowance and the new queue empties for the rest of the day.
        for i in 0..3 {
            grade(&conn, &format!("v/n{i}.md"), Grade::Good, T0, &config).unwrap();
        }
        let q = queue(&conn, 50, T0, &config).unwrap();
        assert_eq!(q.new_done_today, 3);
        assert_eq!(q.new_remaining_today, 0);
        assert!(q.new_cards.is_empty());
    }

    #[test]
    fn suspended_cards_leave_the_queue_but_keep_their_schedule() {
        let conn = test_db();
        add_note(&conn, "v/a.md", "A", "body");
        let config = FsrsConfig { enable_fuzz: false, ..Default::default() };
        add_cards(&conn, &["v/a.md".to_string()], T0).unwrap();
        grade(&conn, "v/a.md", Grade::Good, T0, &config).unwrap();
        let scheduled = get_card(&conn, "v/a.md").unwrap().unwrap();

        assert!(set_suspended(&conn, "v/a.md", true).unwrap());
        let q = queue(&conn, 20, scheduled.due_at_ms, &config).unwrap();
        assert!(q.due.is_empty() && q.new_cards.is_empty());
        assert_eq!(card_status(&conn, "v/a.md").unwrap(), Some(true));

        // Unsuspending restores exactly the card that was there.
        set_suspended(&conn, "v/a.md", false).unwrap();
        let restored = get_card(&conn, "v/a.md").unwrap().unwrap();
        assert_eq!(restored.due_at_ms, scheduled.due_at_ms);
        assert_eq!(restored.reps, scheduled.reps);
    }

    #[test]
    fn removing_a_card_keeps_its_history() {
        let conn = test_db();
        add_note(&conn, "v/a.md", "A", "body");
        let config = FsrsConfig::default();
        grade(&conn, "v/a.md", Grade::Good, T0, &config).unwrap();

        assert!(remove_card(&conn, "v/a.md").unwrap());
        assert!(get_card(&conn, "v/a.md").unwrap().is_none());
        let logged: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(logged, 1, "history is the record of the user's study, not the note's");
    }

    #[test]
    fn stats_counts_states_forecasts_and_measures_mature_retention() {
        let conn = test_db();
        let config = FsrsConfig { enable_fuzz: false, ..Default::default() };
        for i in 0..4 {
            let path = format!("v/n{i}.md");
            add_note(&conn, &path, &format!("N{i}"), "body");
            add_cards(&conn, &[path], T0 + i).unwrap();
        }
        // Two cards graduate; one of them then lapses from `review` state.
        grade(&conn, "v/n0.md", Grade::Easy, T0, &config).unwrap();
        let n1 = grade(&conn, "v/n1.md", Grade::Easy, T0, &config).unwrap();
        grade(&conn, "v/n1.md", Grade::Again, n1.due_at_ms, &config).unwrap();

        let s = stats(&conn, T0).unwrap();
        assert_eq!(s.total_cards, 4);
        assert_eq!(s.new_count, 2);
        assert_eq!(s.review_count, 1);
        assert_eq!(s.relearning_count, 1);
        assert_eq!(s.forecast.len(), FORECAST_DAYS as usize + 1);
        assert_eq!(s.total_reviews, 3);
        // One mature review, and it was a lapse.
        assert_eq!(s.retention_rate, Some(0.0));
        assert!(s.streak_days >= 1);
    }

    #[test]
    fn retention_is_none_before_any_mature_review() {
        let conn = test_db();
        add_note(&conn, "v/a.md", "A", "body");
        // A learning-step repeat is a drill, not a retention measurement.
        grade(&conn, "v/a.md", Grade::Again, T0, &FsrsConfig::default()).unwrap();
        assert_eq!(stats(&conn, T0).unwrap().retention_rate, None);
    }

    #[test]
    fn config_round_trips_through_app_settings() {
        let conn = test_db();
        let want = FsrsConfig {
            desired_retention: 0.85,
            maximum_interval_days: 730,
            learning_steps: vec![2, 15, 30],
            enable_fuzz: false,
            new_per_day: 5,
            reviews_per_day: 50,
        };
        save_config(&conn, &want).unwrap();
        assert_eq!(load_config(&conn), want);
    }

    #[test]
    fn a_garbage_settings_row_is_clamped_rather_than_fatal() {
        let conn = test_db();
        for (key, value) in [
            (DESIRED_RETENTION_KEY, "9.9"),
            (MAXIMUM_INTERVAL_KEY, "-5"),
            (LEARNING_STEPS_KEY, "abc,,xyz"),
            (NEW_PER_DAY_KEY, "not-a-number"),
        ] {
            crate::db::schema::set_setting(&conn, key, value).unwrap();
        }
        let got = load_config(&conn);
        assert_eq!(got.desired_retention, fsrs::DESIRED_RETENTION_RANGE.1);
        assert_eq!(got.maximum_interval_days, fsrs::MAXIMUM_INTERVAL_RANGE.0);
        // Unparseable rows fall back to the shipped defaults.
        assert_eq!(got.learning_steps, FsrsConfig::default().learning_steps);
        assert_eq!(got.new_per_day, FsrsConfig::default().new_per_day);
    }

    #[test]
    fn local_day_start_is_a_midnight_at_or_before_now() {
        let start = local_day_start_ms(T0);
        assert!(start <= T0);
        assert!(T0 - start < MS_PER_DAY);
        // Idempotent: bucketing a bucket boundary must not move it.
        assert_eq!(local_day_start_ms(start), start);
    }

    #[test]
    fn preview_leaves_short_text_alone() {
        assert_eq!(preview_of("  hello   world \n"), "hello world");
        assert_eq!(preview_of(""), "");
    }

    #[test]
    fn queue_entries_carry_the_four_button_labels_in_grade_order() {
        let conn = test_db();
        add_note(&conn, "v/a.md", "A", "body");
        let config = FsrsConfig { enable_fuzz: false, ..Default::default() };
        add_cards(&conn, &["v/a.md".to_string()], T0).unwrap();

        let q = queue(&conn, 10, T0, &config).unwrap();
        let previews = &q.new_cards[0].grade_previews;
        assert_eq!(previews.len(), 4);
        assert_eq!(
            previews.iter().map(|p| p.grade).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        // A new card: the first three are learning steps (minutes), Easy graduates.
        assert_eq!(previews[0].state, State::Learning);
        assert_eq!(previews[3].state, State::Review);
        assert!(previews[0].interval_minutes < previews[2].interval_minutes);
        assert!(previews[3].interval_days >= 1);

        // Previewing must not have written anything.
        let logged: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(logged, 0);
    }
}
