//! FSRS-4.5 — the scheduling arithmetic behind spaced repetition.
//!
//! Pure functions, no DB, no I/O, no clock: `review()` takes `now_ms` as an
//! argument precisely so every path here is deterministic and testable.
//! Persistence lives in [`crate::db::review_store`], transport in
//! `commands::review_commands`.
//!
//! ## Why FSRS-4.5 and not 5/6
//!
//! FSRS-5 and -6 add short-term-memory weights whose value only materialises
//! once the parameters have been *optimised against the user's own review log*.
//! There is no optimiser in this build (that would mean shipping burn/ndarray —
//! hundreds of MB into a local-first note app), so the newer versions would run
//! on their generic defaults and buy nothing. 4.5 is the last version whose
//! published defaults are meant to stand on their own.
//!
//! ## Why the weights are hand-written instead of the `fsrs` crate
//!
//! The crate exists to *train* weights; the forward pass it wraps is the ~80
//! lines below. Vendoring the arithmetic keeps the dependency tree — and the
//! installer — the size it is today.

use serde::{Deserialize, Serialize};

/// The four grades a reviewer can give, numbered as FSRS numbers them.
///
/// The discriminants are part of the storage format (`review_log.grade`), so
/// they must not be renumbered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Grade {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

impl Grade {
    /// Parse a grade off the wire. `None` for anything outside 1–4 rather than a
    /// silent default: a mis-sent grade would corrupt the schedule permanently.
    pub fn from_i64(value: i64) -> Option<Grade> {
        match value {
            1 => Some(Grade::Again),
            2 => Some(Grade::Hard),
            3 => Some(Grade::Good),
            4 => Some(Grade::Easy),
            _ => None,
        }
    }

    pub fn as_i64(self) -> i64 {
        self as i64
    }

    fn as_f64(self) -> f64 {
        self as i64 as f64
    }

    /// Everything except `Again` counts as recall; `Again` is a lapse.
    pub fn is_lapse(self) -> bool {
        matches!(self, Grade::Again)
    }
}

/// Card lifecycle. Stored as text in `review_cards.state` so a DB dump stays
/// readable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    New,
    Learning,
    Review,
    Relearning,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::New => "new",
            State::Learning => "learning",
            State::Review => "review",
            State::Relearning => "relearning",
        }
    }

    /// Lenient on purpose: this is the *read* path. A row written by another
    /// build must not be able to fail a queue load, and `New` is the safe
    /// fallback because it re-teaches rather than over-delaying.
    pub fn from_str_lenient(s: &str) -> State {
        match s {
            "learning" => State::Learning,
            "review" => State::Review,
            "relearning" => State::Relearning,
            _ => State::New,
        }
    }
}

/// The 17 published FSRS-4.5 default weights.
///
/// Taken from the open-source FSRS project (MIT licensed) — the same values
/// py-fsrs 4.5 and ts-fsrs ship as `default_w`. They are population averages
/// fitted over a very large public review dataset.
///
/// This build does **not** optimise them per user: parameter fitting needs an
/// autodiff stack and a few hundred of the user's own reviews before it beats
/// the defaults, and neither is available here. The `review_log` table records
/// everything such an optimiser would need, so the option stays open.
pub const W: [f64; 17] = [
    0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.0310, 1.6474, 0.1367, 1.0461,
    2.1072, 0.0793, 0.3246, 1.5870, 0.2272, 2.8755,
];

/// Exponent of the FSRS-4.5 power forgetting curve.
pub const DECAY: f64 = -0.5;

/// Curve constant, chosen so that `retrievability(S, S) == 0.9`.
/// Equals `0.9^(1/DECAY) - 1` = 19/81.
pub const FACTOR: f64 = 19.0 / 81.0;

/// Difficulty is defined on `[1, 10]`.
const D_MIN: f64 = 1.0;
const D_MAX: f64 = 10.0;

/// Stability floor. Zero stability would divide by zero in the forgetting curve.
const S_MIN: f64 = 0.1;

/// Accepted ranges for the user-settable knobs, exposed so the command layer can
/// quote the exact bounds instead of duplicating them. Same asymmetry as the
/// rerank config: the setter rejects, the startup restore clamps.
pub const DESIRED_RETENTION_RANGE: (f64, f64) = (0.70, 0.98);
pub const MAXIMUM_INTERVAL_RANGE: (i64, i64) = (1, 36_500);
pub const NEW_PER_DAY_RANGE: (i64, i64) = (0, 9_999);
pub const REVIEWS_PER_DAY_RANGE: (i64, i64) = (0, 9_999);

/// Scheduling configuration.
///
/// `new_per_day` / `reviews_per_day` are queue *policy* rather than algorithm —
/// every function in this module ignores them — but they live here because they
/// are the same settings row, the same settings card and the same PATCH command
/// as the algorithm knobs, and splitting them across two structs would buy the
/// caller nothing but an extra layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FsrsConfig {
    /// Probability of recall the scheduler aims for at the moment a card comes
    /// due. Higher means shorter intervals and more reviews.
    pub desired_retention: f64,
    /// Hard ceiling on any interval. 36500 days ≈ 100 years, i.e. effectively
    /// no ceiling, matching Anki's default.
    pub maximum_interval_days: i64,
    /// Intra-day delays in **minutes** for cards that have not graduated yet.
    /// The first entry is where a lapse lands; the last is a passing step.
    pub learning_steps: Vec<u32>,
    /// Spread intervals by a few percent so cards introduced together do not
    /// come back together forever. See [`apply_fuzz`].
    pub enable_fuzz: bool,
    /// Cap on unseen cards introduced per day. Without it a 5000-note vault
    /// hands the user a 5000-card queue on day one, which is the same as
    /// handing them nothing.
    pub new_per_day: i64,
    /// Cap on due cards served per day, for the same reason.
    pub reviews_per_day: i64,
}

impl Default for FsrsConfig {
    fn default() -> Self {
        Self {
            desired_retention: 0.90,
            maximum_interval_days: 36_500,
            // Anki's shipped default. Two steps is enough to separate "I have
            // no idea" from "I nearly had it" without turning a session into a
            // drill.
            learning_steps: vec![1, 10],
            enable_fuzz: true,
            new_per_day: 20,
            reviews_per_day: 200,
        }
    }
}

impl FsrsConfig {
    /// Clamp every field into range. Used on the *restore* path, where erroring
    /// out is not an option: whatever is in the DB, the queue has to load.
    pub fn clamped(mut self) -> Self {
        self.desired_retention = self
            .desired_retention
            .clamp(DESIRED_RETENTION_RANGE.0, DESIRED_RETENTION_RANGE.1);
        self.maximum_interval_days = self
            .maximum_interval_days
            .clamp(MAXIMUM_INTERVAL_RANGE.0, MAXIMUM_INTERVAL_RANGE.1);
        self.new_per_day = self.new_per_day.clamp(NEW_PER_DAY_RANGE.0, NEW_PER_DAY_RANGE.1);
        self.reviews_per_day = self
            .reviews_per_day
            .clamp(REVIEWS_PER_DAY_RANGE.0, REVIEWS_PER_DAY_RANGE.1);
        self.learning_steps.retain(|m| *m >= 1 && *m <= 1_440);
        if self.learning_steps.is_empty() {
            self.learning_steps = FsrsConfig::default().learning_steps;
        }
        self
    }

    /// Delay in minutes for a card that stays in (Re)learning.
    ///
    /// `Again` restarts at the first step. `Hard` sits between the first and the
    /// last step — the same "somewhere in the middle" that upstream FSRS gets
    /// from its hard-coded 1/5/10 ladder, but derived from the configured steps
    /// so a user who changes them is actually obeyed.
    fn step_minutes(&self, grade: Grade) -> u32 {
        let first = *self.learning_steps.first().unwrap_or(&1);
        let last = *self.learning_steps.last().unwrap_or(&10);
        match grade {
            Grade::Again => first,
            Grade::Hard => ((first + last) / 2).max(first),
            // Good/Easy graduate instead of stepping; callers never ask.
            _ => last,
        }
    }
}

// ── The algorithm ───────────────────────────────────────────────────────────

/// Stability of a brand-new card after its very first grade: literally `w[0..4]`.
pub fn initial_stability(grade: Grade) -> f64 {
    W[grade as usize - 1].max(S_MIN)
}

/// Difficulty of a brand-new card after its very first grade.
///
/// FSRS-4.5's D0 is *linear* in the grade (`w4 - w5·(g-3)`); the exponential
/// form belongs to FSRS-5. `Good` (grade 3) lands exactly on `w[4]`, which is
/// also the mean-reversion target below.
pub fn initial_difficulty(grade: Grade) -> f64 {
    (W[4] - W[5] * (grade.as_f64() - 3.0)).clamp(D_MIN, D_MAX)
}

/// Difficulty after a review, with mean reversion toward `w[4]` (the difficulty
/// a `Good` first answer produces).
///
/// The reversion term is what stops a long run of `Hard` from pinning a card at
/// 10 forever: without it difficulty is a one-way ratchet.
pub fn next_difficulty(difficulty: f64, grade: Grade) -> f64 {
    let linear = difficulty - W[6] * (grade.as_f64() - 3.0);
    let reverted = W[7] * W[4] + (1.0 - W[7]) * linear;
    reverted.clamp(D_MIN, D_MAX)
}

/// The FSRS-4.5 power forgetting curve: probability of recall `elapsed_days`
/// after the last review, for a card of the given stability.
///
/// Power rather than exponential because empirically memory decays with a fat
/// tail — an exponential curve badly underestimates recall at long intervals.
pub fn retrievability(elapsed_days: f64, stability: f64) -> f64 {
    let s = stability.max(S_MIN);
    let t = elapsed_days.max(0.0);
    (1.0 + FACTOR * t / s).powf(DECAY)
}

/// Stability after a successful recall (`Hard`, `Good`, `Easy`).
///
/// Note the `(1 - r)` term: reviewing a card you were *about* to forget teaches
/// you far more than reviewing one you still know cold. This is the spacing
/// effect, and it is why the scheduler wants to catch you at ~90% recall rather
/// than at 99%.
pub fn next_recall_stability(difficulty: f64, stability: f64, r: f64, grade: Grade) -> f64 {
    let hard_penalty = if grade == Grade::Hard { W[15] } else { 1.0 };
    let easy_bonus = if grade == Grade::Easy { W[16] } else { 1.0 };
    let s = stability.max(S_MIN);
    let growth = W[8].exp()
        * (11.0 - difficulty)
        * s.powf(-W[9])
        * ((1.0 - r) * W[10]).exp_m1()
        * hard_penalty
        * easy_bonus;
    (s * (1.0 + growth)).max(S_MIN)
}

/// Stability after a lapse (`Again`). Not a reset to zero — a forgotten card is
/// still easier to relearn than a card never seen, and the formula keeps a
/// fraction of the old stability to express that.
pub fn next_forget_stability(difficulty: f64, stability: f64, r: f64) -> f64 {
    let s = stability.max(S_MIN);
    let next =
        W[11] * difficulty.powf(-W[12]) * ((s + 1.0).powf(W[13]) - 1.0) * ((1.0 - r) * W[14]).exp();
    // A lapse must never *raise* stability, which the raw formula can do for a
    // very low-stability card.
    next.clamp(S_MIN, s)
}

/// Stability after a review, dispatching on the three cases.
///
/// The same-day branch is explicit rather than left to fall out of the
/// arithmetic. With `elapsed_days == 0` retrievability is exactly 1, so the
/// recall formula's `exp_m1(0)` term is 0 and stability is unchanged — which is
/// the documented FSRS-4.5 behaviour (it has no short-term-memory weights;
/// those arrived in FSRS-5). Spelling it out means a reader does not have to
/// re-derive that a same-day "Good" is deliberately worth nothing.
pub fn next_stability(
    difficulty: f64,
    stability: f64,
    elapsed_days: f64,
    grade: Grade,
) -> f64 {
    let r = retrievability(elapsed_days, stability);
    if grade.is_lapse() {
        return next_forget_stability(difficulty, stability, r);
    }
    if elapsed_days < 1.0 {
        // Same-day repeat: no new memory is formed, so nothing is earned.
        return stability.max(S_MIN);
    }
    next_recall_stability(difficulty, stability, r, grade)
}

/// Days until recall probability is expected to fall to `desired_retention`.
///
/// Inverts the forgetting curve, then clamps to `[1, maximum_interval_days]`:
/// sub-day intervals belong to the learning steps, not here.
pub fn next_interval(stability: f64, desired_retention: f64, maximum_interval_days: i64) -> i64 {
    let retention = desired_retention.clamp(DESIRED_RETENTION_RANGE.0, DESIRED_RETENTION_RANGE.1);
    let max_days = maximum_interval_days.clamp(MAXIMUM_INTERVAL_RANGE.0, MAXIMUM_INTERVAL_RANGE.1);
    let raw = stability.max(S_MIN) / FACTOR * (retention.powf(1.0 / DECAY) - 1.0);
    (raw.round() as i64).clamp(1, max_days)
}

/// Interval fuzz bands, as `(start, end, factor)` in days. Straight from
/// upstream FSRS: short intervals get spread ±15%, long ones ±5%.
const FUZZ_RANGES: [(f64, f64, f64); 3] = [
    (2.5, 7.0, 0.15),
    (7.0, 20.0, 0.10),
    (20.0, f64::INFINITY, 0.05),
];

/// A stable pseudo-random fraction in `[0, 1)` derived from the card key and its
/// review count. FNV-1a, inlined — a 6-line hash is not worth a dependency.
fn fuzz_fraction(key: &str, reps: u32) -> f64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |byte: u8| {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    };
    // Bytes, not chars: this is a hash, never a slice, so multi-byte UTF-8 in a
    // CJK path is simply more input.
    for b in key.as_bytes() {
        mix(*b);
    }
    for b in reps.to_le_bytes() {
        mix(b);
    }
    // Top 53 bits — the mantissa width of f64.
    (hash >> 11) as f64 / (1u64 << 53) as f64
}

/// Spread an interval by a few percent so cards learned on the same day stop
/// arriving on the same day forever.
///
/// Upstream FSRS draws this from a real RNG. Here it is derived from
/// `hash(key + reps)` instead, for two reasons: a nondeterministic scheduler
/// cannot be unit-tested (and this one is, below), and re-grading the same card
/// after an app restart should not silently produce a different interval.
/// Hashing in `reps` is what keeps successive reviews of one note from all
/// landing on the same side of the band.
pub fn apply_fuzz(interval: i64, key: &str, reps: u32, maximum_interval_days: i64) -> i64 {
    let max_days = maximum_interval_days.clamp(MAXIMUM_INTERVAL_RANGE.0, MAXIMUM_INTERVAL_RANGE.1);
    if interval < 2 || max_days < 2 {
        // A 1-day interval has nowhere to move without becoming 0.
        return interval.clamp(1, max_days.max(1));
    }
    let ivl = interval as f64;
    let mut delta = 1.0;
    for (start, end, factor) in FUZZ_RANGES {
        delta += factor * (ivl.min(end) - start).max(0.0);
    }
    let min_ivl = ((ivl - delta).round() as i64).max(2);
    let max_ivl = ((ivl + delta).round() as i64).min(max_days);
    if max_ivl <= min_ivl {
        return min_ivl.min(max_days);
    }
    let span = (max_ivl - min_ivl + 1) as f64;
    let offset = (fuzz_fraction(key, reps) * span).floor() as i64;
    (min_ivl + offset).min(max_ivl)
}

/// One scheduled note.
///
/// `key` is the note's `file_path` — the primary key of `review_cards`, and the
/// only stable note identity this app has. It is on the card rather than passed
/// separately so that [`review`] stays a two-argument pure function of card and
/// grade; the fuzz derivation is the only thing that reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub key: String,
    pub stability: f64,
    pub difficulty: f64,
    /// When this card next becomes due, in epoch milliseconds.
    pub due_at_ms: i64,
    /// Epoch ms of the last grade, or `None` for a card that has never been seen.
    pub last_review_ms: Option<i64>,
    /// Days between the previous review and this one. Recomputed by [`review`];
    /// persisted only so the `review_log` row can record it.
    pub elapsed_days: f64,
    /// Days the interval that just elapsed was *supposed* to last.
    pub scheduled_days: f64,
    pub reps: u32,
    pub lapses: u32,
    pub state: State,
}

impl Card {
    /// A never-reviewed card, due immediately.
    pub fn new(key: impl Into<String>, now_ms: i64) -> Self {
        Self {
            key: key.into(),
            stability: 0.0,
            difficulty: 0.0,
            due_at_ms: now_ms,
            last_review_ms: None,
            elapsed_days: 0.0,
            scheduled_days: 0.0,
            reps: 0,
            lapses: 0,
            state: State::New,
        }
    }

    /// Interval in whole days between the last review and `now_ms`.
    ///
    /// Zero for a new card: FSRS treats "never reviewed" as elapsed 0 rather
    /// than as infinitely overdue.
    pub fn elapsed_days_at(&self, now_ms: i64) -> f64 {
        match self.last_review_ms {
            Some(last) if self.state != State::New => {
                ((now_ms - last).max(0) as f64) / 86_400_000.0
            }
            _ => 0.0,
        }
    }
}

const MS_PER_DAY: i64 = 86_400_000;
const MS_PER_MINUTE: i64 = 60_000;

/// Apply one grade to a card and return the rescheduled copy.
///
/// The state machine, which is FSRS-4.5's:
///
/// - `New` → `Again`/`Hard`/`Good` enter `Learning` with an intra-day delay;
///   `Easy` skips straight to `Review`. Someone who finds a card trivial on
///   first sight should not be drilled ten minutes later.
/// - `Learning`/`Relearning` → `Again`/`Hard` stay put and come back within the
///   session; `Good`/`Easy` graduate to `Review`.
/// - `Review` → `Again` drops to `Relearning` and counts a lapse; everything
///   else stays in `Review` with a longer interval.
///
/// Note there is no learning-step *index*: the ladder is expressed entirely by
/// the state plus the grade, which is what lets the card row stay flat.
pub fn review(card: &Card, grade: Grade, now_ms: i64, config: &FsrsConfig) -> Card {
    let elapsed_days = card.elapsed_days_at(now_ms);
    let mut next = card.clone();
    next.elapsed_days = elapsed_days;
    next.last_review_ms = Some(now_ms);
    next.reps = card.reps.saturating_add(1);

    let (stability, difficulty) = if card.state == State::New {
        (initial_stability(grade), initial_difficulty(grade))
    } else {
        // Difficulty first: FSRS-4.5 feeds the *updated* difficulty into the
        // stability formulas.
        let d = next_difficulty(card.difficulty, grade);
        (next_stability(d, card.stability, elapsed_days, grade), d)
    };
    next.stability = stability;
    next.difficulty = difficulty;

    // Graduating means "schedule in days"; stepping means "come back within the
    // hour". Which one applies is the whole state machine.
    let graduates = match card.state {
        State::New => grade == Grade::Easy,
        State::Learning | State::Relearning => matches!(grade, Grade::Good | Grade::Easy),
        State::Review => grade != Grade::Again,
    };

    if card.state == State::Review && grade == Grade::Again {
        next.lapses = card.lapses.saturating_add(1);
    }

    if graduates {
        next.state = State::Review;
        let mut days = next_interval(stability, config.desired_retention, config.maximum_interval_days);
        if config.enable_fuzz {
            days = apply_fuzz(days, &next.key, next.reps, config.maximum_interval_days);
        }
        next.scheduled_days = days as f64;
        next.due_at_ms = now_ms + days * MS_PER_DAY;
    } else {
        next.state = match card.state {
            State::New | State::Learning => State::Learning,
            State::Review | State::Relearning => State::Relearning,
        };
        let minutes = config.step_minutes(grade) as i64;
        next.scheduled_days = 0.0;
        next.due_at_ms = now_ms + minutes * MS_PER_MINUTE;
    }

    next
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn cfg() -> FsrsConfig {
        // Fuzz off by default in tests: it is exercised on its own below, and
        // leaving it on would make every interval assertion approximate.
        FsrsConfig { enable_fuzz: false, ..FsrsConfig::default() }
    }

    /// Drive a card to `Review` state the way a real session would, so the
    /// interval tests start from a realistic card rather than a hand-built one.
    fn graduated(config: &FsrsConfig) -> Card {
        let card = Card::new("notes/CJK 笔记.md", T0);
        review(&card, Grade::Easy, T0, config)
    }

    #[test]
    fn new_card_grades_are_ordered_by_stability() {
        // w[0..4] is ascending, and that ordering is the foundation the rest of
        // the algorithm's monotonicity rests on.
        let s: Vec<f64> = [Grade::Again, Grade::Hard, Grade::Good, Grade::Easy]
            .iter()
            .map(|g| initial_stability(*g))
            .collect();
        assert!(s[0] < s[1] && s[1] < s[2] && s[2] < s[3], "got {s:?}");
    }

    #[test]
    fn initial_difficulty_falls_as_the_grade_rises() {
        let d: Vec<f64> = [Grade::Again, Grade::Hard, Grade::Good, Grade::Easy]
            .iter()
            .map(|g| initial_difficulty(*g))
            .collect();
        assert!(d[0] > d[1] && d[1] > d[2] && d[2] > d[3], "got {d:?}");
        assert!(d.iter().all(|v| (D_MIN..=D_MAX).contains(v)));
    }

    #[test]
    fn difficulty_stays_in_range_under_extreme_streaks() {
        // The ratchet this guards against: 200 straight lapses must not push
        // difficulty past 10, and 200 straight Easys must not push it below 1.
        let mut hard = 5.0;
        let mut easy = 5.0;
        for _ in 0..200 {
            hard = next_difficulty(hard, Grade::Again);
            easy = next_difficulty(easy, Grade::Easy);
        }
        assert!((D_MIN..=D_MAX).contains(&hard), "hard drifted to {hard}");
        assert!((D_MIN..=D_MAX).contains(&easy), "easy drifted to {easy}");
        assert!(hard > easy);
    }

    #[test]
    fn retrievability_decays_and_is_pinned_at_the_definition_points() {
        // r(0) == 1 by definition, and r(S) == 0.9 is what FACTOR is chosen for.
        assert!((retrievability(0.0, 10.0) - 1.0).abs() < 1e-9);
        assert!((retrievability(10.0, 10.0) - 0.9).abs() < 1e-6);
        let mut previous = 1.0;
        for days in 1..60 {
            let r = retrievability(days as f64, 10.0);
            assert!(r < previous, "r must be monotonically decreasing at {days}d");
            assert!(r > 0.0);
            previous = r;
        }
    }

    #[test]
    fn intervals_are_ordered_easy_ge_good_ge_hard_ge_again() {
        let config = cfg();
        let base = graduated(&config);
        let later = base.due_at_ms;

        let intervals: Vec<i64> = [Grade::Again, Grade::Hard, Grade::Good, Grade::Easy]
            .iter()
            .map(|g| review(&base, *g, later, &config).due_at_ms - later)
            .collect();

        assert!(
            intervals[0] <= intervals[1]
                && intervals[1] <= intervals[2]
                && intervals[2] <= intervals[3],
            "grade order violated: {intervals:?}"
        );
        // And Again must be the only one measured in minutes.
        assert!(intervals[0] < MS_PER_DAY, "a lapse should return within the day");
        assert!(intervals[3] > MS_PER_DAY);
    }

    #[test]
    fn a_lapse_drops_a_review_card_into_relearning_and_counts_it() {
        let config = cfg();
        let base = graduated(&config);
        assert_eq!(base.state, State::Review);
        assert_eq!(base.lapses, 0);

        let lapsed = review(&base, Grade::Again, base.due_at_ms, &config);
        assert_eq!(lapsed.state, State::Relearning);
        assert_eq!(lapsed.lapses, 1);
        assert!(lapsed.stability <= base.stability, "a lapse must not raise stability");
        // Back within the first learning step, not tomorrow.
        let minutes = (lapsed.due_at_ms - base.due_at_ms) / MS_PER_MINUTE;
        assert_eq!(minutes, config.learning_steps[0] as i64);

        // And relearning graduates back to Review on a pass.
        let regraduated = review(&lapsed, Grade::Good, lapsed.due_at_ms, &config);
        assert_eq!(regraduated.state, State::Review);
    }

    #[test]
    fn new_card_walks_the_learning_steps_then_graduates() {
        let config = cfg();
        let fresh = Card::new("notes/a.md", T0);
        assert_eq!(fresh.state, State::New);

        let stepped = review(&fresh, Grade::Good, T0, &config);
        assert_eq!(stepped.state, State::Learning);
        assert_eq!(
            (stepped.due_at_ms - T0) / MS_PER_MINUTE,
            *config.learning_steps.last().unwrap() as i64
        );
        assert_eq!(stepped.scheduled_days, 0.0);

        let graduated = review(&stepped, Grade::Good, stepped.due_at_ms, &config);
        assert_eq!(graduated.state, State::Review);
        assert!(graduated.scheduled_days >= 1.0);
        assert_eq!(graduated.reps, 2);
    }

    #[test]
    fn easy_on_a_new_card_skips_the_learning_steps() {
        let config = cfg();
        let card = review(&Card::new("notes/a.md", T0), Grade::Easy, T0, &config);
        assert_eq!(card.state, State::Review);
        assert!(card.due_at_ms - T0 >= MS_PER_DAY);
    }

    #[test]
    fn stability_grows_across_successful_reviews() {
        let config = cfg();
        let mut card = graduated(&config);
        let mut previous = card.stability;
        for _ in 0..8 {
            let now = card.due_at_ms;
            card = review(&card, Grade::Good, now, &config);
            assert!(
                card.stability > previous,
                "stability should grow on recall: {previous} -> {}",
                card.stability
            );
            previous = card.stability;
        }
        // Eight successful reviews should have pushed this well past a year.
        assert!(card.scheduled_days > 365.0, "got {} days", card.scheduled_days);
    }

    #[test]
    fn same_day_review_earns_nothing() {
        let config = cfg();
        let card = graduated(&config);
        // Graded again the same instant it graduated: retrievability is 1, so
        // there is no new memory to reward.
        let again_same_day = review(&card, Grade::Good, card.last_review_ms.unwrap(), &config);
        assert!((again_same_day.stability - card.stability).abs() < 1e-9);
    }

    #[test]
    fn interval_is_clamped_at_both_ends() {
        // Floor: a near-zero stability card still comes back tomorrow, not today.
        assert_eq!(next_interval(0.01, 0.90, 36_500), 1);
        // Ceiling: an absurd stability is capped by the configured maximum.
        assert_eq!(next_interval(1e9, 0.90, 365), 365);
        // And the retention knob itself is clamped, so a nonsense value cannot
        // produce a nonsense interval.
        assert!(next_interval(10.0, 5.0, 36_500) >= 1);
        assert!(next_interval(10.0, -1.0, 36_500) >= 1);
    }

    #[test]
    fn higher_desired_retention_means_shorter_intervals() {
        let low = next_interval(100.0, 0.80, 36_500);
        let high = next_interval(100.0, 0.95, 36_500);
        assert!(high < low, "0.95 retention should review sooner: {high} vs {low}");
    }

    #[test]
    fn fuzz_is_deterministic_and_stays_inside_the_band() {
        let key = "笔记/间隔重复.md";
        let a = apply_fuzz(30, key, 4, 36_500);
        let b = apply_fuzz(30, key, 4, 36_500);
        assert_eq!(a, b, "same key + reps must always fuzz identically");

        // ±5% of 30 days plus the constant 1 day ⇒ within 3 days either way.
        assert!((27..=33).contains(&a), "fuzzed to {a}");

        // Different reps must be able to move the value, or fuzz is a no-op
        // across a card's life.
        let spread: std::collections::BTreeSet<i64> =
            (0..24).map(|reps| apply_fuzz(30, key, reps, 36_500)).collect();
        assert!(spread.len() > 1, "fuzz never varied across reps: {spread:?}");

        // Short intervals and the ceiling are both left alone.
        assert_eq!(apply_fuzz(1, key, 1, 36_500), 1);
        assert!(apply_fuzz(400, key, 1, 365) <= 365);
    }

    #[test]
    fn fuzz_does_not_change_the_grade_ordering() {
        let config = FsrsConfig::default();
        let base = graduated(&config);
        let later = base.due_at_ms;
        let good = review(&base, Grade::Good, later, &config).due_at_ms - later;
        let easy = review(&base, Grade::Easy, later, &config).due_at_ms - later;
        assert!(easy > good, "fuzz must not be large enough to invert grades");
    }

    #[test]
    fn config_clamping_repairs_garbage_rows() {
        let repaired = FsrsConfig {
            desired_retention: 1.5,
            maximum_interval_days: -3,
            learning_steps: vec![0, 99_999],
            enable_fuzz: true,
            new_per_day: -10,
            reviews_per_day: 1_000_000,
        }
        .clamped();
        assert_eq!(repaired.desired_retention, DESIRED_RETENTION_RANGE.1);
        assert_eq!(repaired.maximum_interval_days, MAXIMUM_INTERVAL_RANGE.0);
        assert_eq!(repaired.new_per_day, NEW_PER_DAY_RANGE.0);
        assert_eq!(repaired.reviews_per_day, REVIEWS_PER_DAY_RANGE.1);
        // Every step was out of range, so the shipped ladder comes back.
        assert_eq!(repaired.learning_steps, FsrsConfig::default().learning_steps);
    }

    #[test]
    fn grade_and_state_round_trip_through_storage_form() {
        for value in 1..=4 {
            assert_eq!(Grade::from_i64(value).unwrap().as_i64(), value);
        }
        assert!(Grade::from_i64(0).is_none());
        assert!(Grade::from_i64(5).is_none());

        for state in [State::New, State::Learning, State::Review, State::Relearning] {
            assert_eq!(State::from_str_lenient(state.as_str()), state);
        }
        // Unknown text degrades to New rather than failing a queue load.
        assert_eq!(State::from_str_lenient("suspended-ish"), State::New);
    }

    #[test]
    fn overdue_cards_earn_more_stability_than_punctual_ones() {
        // The spacing effect, which is the reason to use FSRS at all.
        let config = cfg();
        let card = graduated(&config);
        let punctual = review(&card, Grade::Good, card.due_at_ms, &config);
        let overdue = review(&card, Grade::Good, card.due_at_ms + 30 * MS_PER_DAY, &config);
        assert!(
            overdue.stability > punctual.stability,
            "{} should exceed {}",
            overdue.stability,
            punctual.stability
        );
    }
}
