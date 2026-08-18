//! Tauri surface for spaced repetition. Thin by design: every command locks the
//! DB, delegates to [`crate::db::review_store`], and shapes the result.
//!
//! `now_ms` is taken from the system clock here — the one place in this feature
//! that reads a clock, so that `fsrs` and `review_store` stay deterministic.

use tauri::State;

use crate::db::review_store::{self, ReviewQueue, ReviewStats};
use crate::error::ZettelError;
use crate::fsrs::{self, FsrsConfig, Grade, State as CardState};
use crate::AppState;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// How many cards a session fetch returns when the caller doesn't say.
const DEFAULT_QUEUE_LIMIT: usize = 50;

/// The card as the review UI needs to see it after a grade.
///
/// Carries the resulting interval, not just the due timestamp, so the UI can say
/// "下次复习：3 天后" without re-deriving it from a clock it may disagree with.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCardView {
    pub file_path: String,
    pub state: CardState,
    pub due_at_ms: i64,
    pub stability: f64,
    pub difficulty: f64,
    pub reps: u32,
    pub lapses: u32,
    pub suspended: bool,
    /// Whole days until the next review. `0` means the card is still in
    /// (re)learning and comes back within the day — read `interval_minutes`.
    pub interval_days: i64,
    pub interval_minutes: i64,
}

impl ReviewCardView {
    fn from_card(card: &fsrs::Card, suspended: bool, reference_ms: i64) -> Self {
        let delta = (card.due_at_ms - reference_ms).max(0);
        Self {
            file_path: card.key.clone(),
            state: card.state,
            due_at_ms: card.due_at_ms,
            stability: card.stability,
            difficulty: card.difficulty,
            reps: card.reps,
            lapses: card.lapses,
            suspended,
            interval_days: delta / 86_400_000,
            interval_minutes: delta / 60_000,
        }
    }
}

/// Cards to study now: everything due plus the day's allowance of new cards.
#[tauri::command]
pub async fn get_review_queue(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<ReviewQueue, ZettelError> {
    let conn = state.db.lock()?;
    let queue = review_store::queue(
        &conn,
        limit.unwrap_or(DEFAULT_QUEUE_LIMIT),
        now_ms(),
        &review_store::active_config(),
    )?;
    Ok(queue)
}

/// Apply a grade (1–4) and return the rescheduled card.
#[tauri::command]
pub async fn grade_card(
    state: State<'_, AppState>,
    file_path: String,
    grade: i64,
) -> Result<ReviewCardView, ZettelError> {
    // Strict: a grade outside 1–4 would silently corrupt the schedule, and the
    // only way it can happen is a frontend bug worth surfacing.
    let parsed = Grade::from_i64(grade).ok_or_else(|| {
        ZettelError::System(format!(
            "无效的评分 `{}`（应为 1=重来 2=困难 3=良好 4=简单） / \
invalid grade `{}` (expected 1=again 2=hard 3=good 4=easy)",
            grade, grade
        ))
    })?;

    let reference = now_ms();
    let conn = state.db.lock()?;
    let card = review_store::grade(
        &conn,
        &file_path,
        parsed,
        reference,
        &review_store::active_config(),
    )?;
    let suspended = review_store::card_status(&conn, &file_path)?.unwrap_or(false);
    Ok(ReviewCardView::from_card(&card, suspended, reference))
}

/// Add notes to the deck. Returns how many were newly added — already-studied
/// notes are left exactly as they are.
#[tauri::command]
pub async fn add_cards_to_review(
    state: State<'_, AppState>,
    file_paths: Vec<String>,
) -> Result<usize, ZettelError> {
    let conn = state.db.lock()?;
    let added = review_store::add_cards(&conn, &file_paths, now_ms())?;
    Ok(added)
}

#[tauri::command]
pub async fn remove_card_from_review(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<bool, ZettelError> {
    let conn = state.db.lock()?;
    Ok(review_store::remove_card(&conn, &file_path)?)
}

#[tauri::command]
pub async fn suspend_card(
    state: State<'_, AppState>,
    file_path: String,
    suspended: bool,
) -> Result<bool, ZettelError> {
    let conn = state.db.lock()?;
    Ok(review_store::set_suspended(&conn, &file_path, suspended)?)
}

/// The current note's card, or `None` when it is not in the deck. Backs the
/// "add to review deck" affordance, which has to know which of the two states it
/// is in before the user clicks.
#[tauri::command]
pub async fn get_review_card(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<Option<ReviewCardView>, ZettelError> {
    let reference = now_ms();
    let conn = state.db.lock()?;
    let Some(card) = review_store::get_card(&conn, &file_path)? else {
        return Ok(None);
    };
    let suspended = review_store::card_status(&conn, &file_path)?.unwrap_or(false);
    Ok(Some(ReviewCardView::from_card(&card, suspended, reference)))
}

#[tauri::command]
pub async fn get_review_stats(state: State<'_, AppState>) -> Result<ReviewStats, ZettelError> {
    let conn = state.db.lock()?;
    Ok(review_store::stats(&conn, now_ms())?)
}

/// Read from process state, not the DB: this is the same value the scheduler
/// uses, so the settings pane can never show a retention target that is not the
/// one actually in force.
#[tauri::command]
pub fn get_fsrs_config() -> Result<FsrsConfig, ZettelError> {
    Ok(review_store::active_config())
}

/// Update + persist the scheduling config.
///
/// PATCH-shaped: every field is an independent `Option<_>` so the UI can change
/// one knob without echoing back the rest, and without a read-modify-write race
/// between two settings panes. Unspecified fields keep their stored value.
///
/// Validation is strict here — unlike the startup restore path, which clamps —
/// because a rejected setting is a bug the user can see and fix, while a
/// silently clamped one is a support ticket.
#[tauri::command]
pub fn set_fsrs_config(
    state: State<'_, AppState>,
    desired_retention: Option<f64>,
    maximum_interval_days: Option<i64>,
    learning_steps: Option<Vec<u32>>,
    enable_fuzz: Option<bool>,
    new_per_day: Option<i64>,
    reviews_per_day: Option<i64>,
) -> Result<FsrsConfig, ZettelError> {
    let mut config = review_store::active_config();

    if let Some(v) = desired_retention {
        if !v.is_finite() {
            return Err(ZettelError::System(
                "desiredRetention 必须是有限小数 / desiredRetention must be a finite number".into(),
            ));
        }
        config.desired_retention = check_range(v, fsrs::DESIRED_RETENTION_RANGE, "desiredRetention")?;
    }
    if let Some(v) = maximum_interval_days {
        config.maximum_interval_days =
            check_range(v, fsrs::MAXIMUM_INTERVAL_RANGE, "maximumIntervalDays")?;
    }
    if let Some(steps) = learning_steps {
        // An empty ladder would leave a lapsed card with nowhere to go, so it is
        // rejected rather than quietly replaced with the default.
        if steps.is_empty() || steps.iter().any(|m| *m < 1 || *m > 1_440) {
            return Err(ZettelError::System(
                "learningSteps 必须是 1–1440 分钟之间的非空列表 / \
learningSteps must be a non-empty list of 1–1440 minute values"
                    .into(),
            ));
        }
        config.learning_steps = steps;
    }
    if let Some(v) = enable_fuzz {
        config.enable_fuzz = v;
    }
    if let Some(v) = new_per_day {
        config.new_per_day = check_range(v, fsrs::NEW_PER_DAY_RANGE, "newPerDay")?;
    }
    if let Some(v) = reviews_per_day {
        config.reviews_per_day = check_range(v, fsrs::REVIEWS_PER_DAY_RANGE, "reviewsPerDay")?;
    }

    // Persist before publishing: if the write fails the user keeps the config
    // they can actually see in the DB, rather than a process-only setting that
    // disappears on restart.
    {
        let conn = state.db.lock()?;
        review_store::save_config(&conn, &config)
            .map_err(|e| ZettelError::System(e.to_string()))?;
    }
    review_store::store_config(config.clone());
    Ok(config)
}

/// Range check shared by every numeric knob, mirroring `search_commands`'s.
/// Generic over the numeric type so `f64` and `i64` knobs get the identical
/// bilingual message.
fn check_range<T: PartialOrd + std::fmt::Display + Copy>(
    value: T,
    range: (T, T),
    field: &str,
) -> Result<T, ZettelError> {
    if value < range.0 || value > range.1 {
        return Err(ZettelError::System(format!(
            "{} = {} 超出允许范围 [{}, {}] / {} = {} is outside the allowed range [{}, {}]",
            field, value, range.0, range.1, field, value, range.0, range.1
        )));
    }
    Ok(value)
}
