//! 承诺与主动提醒 / commitments, open loops, and the proactive gate.
//!
//! ## 为什么"主动"必须先能被关掉
//!
//! 一个会主动说话的第二大脑，做对了很有用，做错了就是骚扰软件。这两者之间的区别
//! 不在提取得多准，而在**克制机制是不是真的生效**。所以本模块的顺序是反过来的：
//! 先有闸门，再有提醒。
//!
//! 四道闸门，每一道都能单独把提醒挡住：
//!
//! 1. 总开关（`proactive_enabled`）——用户说不要就是不要；
//! 2. 免打扰时段（`proactive_quiet_hours`）——深夜不弹；
//! 3. 频率上限（每天几条 + 两条之间的最小间隔）——一次性倒一堆等于没有提醒；
//! 4. 单条开关与 dedupe——同一件事不重复问，被否掉的不复活。
//!
//! ## 状态机与"完成"的定义
//!
//! `proposed → active → done`，另有 `snoozed` / `dismissed` / `expired`。
//!
//! [`complete`] **必须**带完成证据。没有证据的"完成"是一句无法核对的断言，而任务
//! 系统里最坏的失败模式正是它：一堆看起来做完了、其实没人知道有没有做的事。
//!
//! ## 结果回流为什么不直接改笔记
//!
//! 规范要求完成后把结果回流到原 note/object/session/event，而不是只把状态改成
//! done。[`deliver_result`] 的做法是记一条证据、绑到源对象、留一条审计事件——
//! 而**不是**替用户改 Markdown。scheduler 里没有审批闸门，在那里直接写用户的文件
//! 就是"Agent 写入绕过 ChangeSet"，那是明确禁止的。想落到笔记里，走
//! `write_guard` 那条路。

use rusqlite::{params, Connection, OptionalExtension};

use super::evidence;
use super::object_store::{self, ObjectError, ObjectResult};
use super::types::*;

/// 新提一条承诺 / propose one commitment.
#[derive(Debug, Clone)]
pub struct NewCommitment {
    /// `commitment` / `deadline` / `open_loop` / `next_action` / `knowledge_gap` / `event`。
    pub commitment_type: String,
    pub title: String,
    pub object_id: Option<String>,
    pub source: Option<SourceRef>,
    pub evidence_ids: Vec<String>,
    pub owner: Option<String>,
    pub priority: i64,
    pub due_at_ms: Option<i64>,
    pub remind_at_ms: Option<i64>,
    /// 完成后结果回流到哪里（object id、笔记路径或 session id）。
    pub return_target: Option<String>,
    /// 去重键。留空则由类型 + 标题派生。
    pub dedupe_key: Option<String>,
}

impl NewCommitment {
    pub fn new(commitment_type: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            commitment_type: commitment_type.into(),
            title: title.into(),
            object_id: None,
            source: None,
            evidence_ids: Vec::new(),
            owner: None,
            priority: 0,
            due_at_ms: None,
            remind_at_ms: None,
            return_target: None,
            dedupe_key: None,
        }
    }

    /// 派生去重键 / the key that makes "the same commitment" identifiable.
    ///
    /// 用类型 + 标题的规范化形式，而不是 LLM 每次生成的原句：同一件事换个说法就该
    /// 还是同一件事，否则 dedupe 形同虚设。
    ///
    /// 规范化只保留字母数字（`is_alphanumeric` 对汉字为真），把标点和空白全部丢掉。
    /// 用 `is_ascii_punctuation` 是不够的——中文用户打出来的是全角的「！，。」，
    /// 那条判断会全部漏掉，于是"写周报"和"写周报！"变成两条任务。
    fn effective_dedupe_key(&self) -> String {
        if let Some(key) = &self.dedupe_key {
            if !key.trim().is_empty() {
                return key.trim().to_string();
            }
        }
        let normalized: String = self.title.chars().filter(|c| c.is_alphanumeric()).collect();
        format!("{}::{}", self.commitment_type, normalized.to_lowercase())
    }
}

// ── 提议与查询 / proposing and reading ──────────────────────────────────────

/// 提一条承诺，重复的不会变成第二条 / propose, deduplicating on the key.
///
/// 已经存在同一个 dedupe key 时：只补齐时间与优先级，**不动状态、不清提醒计数**。
/// 让重复提议把一条 `dismissed` 的任务拉回 `proposed`，等于用户永远关不掉它。
pub fn propose(conn: &Connection, req: &NewCommitment) -> ObjectResult<TaskCommitment> {
    let key = req.effective_dedupe_key();
    let now = now_ms();

    if let Some(existing) = find_by_dedupe_key(conn, &key)? {
        conn.execute(
            "UPDATE task_commitments SET
                due_at_ms = COALESCE(?2, due_at_ms),
                remind_at_ms = COALESCE(?3, remind_at_ms),
                priority = MAX(priority, ?4),
                object_id = COALESCE(?5, object_id),
                return_target = COALESCE(?6, return_target),
                updated_at_ms = ?7
             WHERE id = ?1",
            params![
                existing.id,
                req.due_at_ms,
                req.remind_at_ms,
                req.priority,
                req.object_id,
                req.return_target,
                now
            ],
        )?;
        return get(conn, &existing.id)?
            .ok_or_else(|| ObjectError::NotFound(existing.id));
    }

    let id = new_object_id();
    let (source_type, source_id) = match &req.source {
        Some(s) => (Some(s.source_type.clone()), Some(s.source_id.clone())),
        None => (None, None),
    };

    conn.execute(
        "INSERT INTO task_commitments
            (id, object_id, commitment_type, title, source_type, source_id, evidence_ids,
             owner, status, priority, due_at_ms, remind_at_ms, dedupe_key,
             proactive_enabled, notify_count, return_target, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'proposed', ?9, ?10, ?11, ?12, 1, 0, ?13, ?14, ?14)",
        params![
            id,
            req.object_id,
            req.commitment_type,
            req.title,
            source_type,
            source_id,
            serde_json::to_string(&req.evidence_ids).unwrap_or_else(|_| "[]".into()),
            req.owner,
            req.priority,
            req.due_at_ms,
            req.remind_at_ms,
            key,
            req.return_target,
            now,
        ],
    )?;

    get(conn, &id)?.ok_or_else(|| ObjectError::NotFound(id))
}

pub fn get(conn: &Connection, id: &str) -> ObjectResult<Option<TaskCommitment>> {
    Ok(query(conn, "WHERE id = ?1", params![id])?.into_iter().next())
}

pub fn find_by_dedupe_key(
    conn: &Connection,
    key: &str,
) -> ObjectResult<Option<TaskCommitment>> {
    Ok(query(conn, "WHERE dedupe_key = ?1", params![key])?
        .into_iter()
        .next())
}

/// 收件箱：等用户处理的那些 / everything waiting on the user.
pub fn inbox(conn: &Connection, limit: usize) -> ObjectResult<Vec<TaskCommitment>> {
    query(
        conn,
        "WHERE status IN ('proposed', 'active')
         ORDER BY priority DESC, COALESCE(due_at_ms, 9223372036854775807), created_at_ms
         LIMIT ?1",
        params![limit as i64],
    )
}

fn query(
    conn: &Connection,
    clause: &str,
    args: impl rusqlite::Params,
) -> ObjectResult<Vec<TaskCommitment>> {
    let sql = format!(
        "SELECT id, object_id, commitment_type, title, source_type, source_id, evidence_ids,
                owner, status, priority, due_at_ms, remind_at_ms, dedupe_key,
                proactive_enabled, last_notified_at_ms, notify_count,
                completion_evidence_id, return_target, created_at_ms, updated_at_ms
         FROM task_commitments {clause}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(args, |r| {
            let source_type: Option<String> = r.get(4)?;
            let source_id: Option<String> = r.get(5)?;
            Ok(TaskCommitment {
                id: r.get(0)?,
                object_id: r.get(1)?,
                commitment_type: r.get(2)?,
                title: r.get(3)?,
                source: match (source_type, source_id) {
                    (Some(source_type), Some(source_id)) => {
                        Some(SourceRef { source_type, source_id })
                    }
                    _ => None,
                },
                evidence_ids: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
                owner: r.get(7)?,
                status: CommitmentStatus::parse(&r.get::<_, String>(8)?)
                    .unwrap_or(CommitmentStatus::Proposed),
                priority: r.get(9)?,
                due_at_ms: r.get(10)?,
                remind_at_ms: r.get(11)?,
                dedupe_key: r.get(12)?,
                proactive_enabled: r.get::<_, i64>(13)? != 0,
                last_notified_at_ms: r.get(14)?,
                notify_count: r.get(15)?,
                completion_evidence_id: r.get(16)?,
                return_target: r.get(17)?,
                created_at_ms: r.get(18)?,
                updated_at_ms: r.get(19)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ── 状态机 / the state machine ──────────────────────────────────────────────

/// 允许的状态迁移 / which transitions are legal.
///
/// `done → active` 之类的回头路一律不给：一条已经带着完成证据结掉的任务重新活过来，
/// 那条证据就变成了在说谎。要重开就再提一条新的。
fn transition_allowed(from: CommitmentStatus, to: CommitmentStatus) -> bool {
    use CommitmentStatus::*;
    match (from, to) {
        (Proposed, Active | Dismissed | Snoozed | Expired | Done) => true,
        (Active, Done | Snoozed | Dismissed | Expired) => true,
        // 打盹结束回到可提醒状态，或者干脆被否掉。
        (Snoozed, Active | Proposed | Dismissed | Expired) => true,
        // 过期的还能被补做完，也能被清掉。
        (Expired, Done | Dismissed) => true,
        _ => false,
    }
}

fn set_status(
    conn: &Connection,
    id: &str,
    to: CommitmentStatus,
) -> ObjectResult<TaskCommitment> {
    let current = get(conn, id)?.ok_or_else(|| ObjectError::NotFound(id.to_string()))?;
    if current.status == to {
        return Ok(current);
    }
    if !transition_allowed(current.status, to) {
        return Err(ObjectError::Search(format!(
            "illegal commitment transition {} → {}",
            current.status.as_str(),
            to.as_str()
        )));
    }
    conn.execute(
        "UPDATE task_commitments SET status = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![id, to.as_str(), now_ms()],
    )?;
    object_store::record_audit(
        conn,
        "user",
        "commitment_status",
        to.as_str(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(
            &serde_json::json!({
                "commitment_id": id,
                "from": current.status.as_str(),
                "to": to.as_str(),
            })
            .to_string(),
        ),
    )?;
    get(conn, id)?.ok_or_else(|| ObjectError::NotFound(id.to_string()))
}

/// 用户接受了这条提议 / the user took it on.
pub fn activate(conn: &Connection, id: &str) -> ObjectResult<TaskCommitment> {
    set_status(conn, id, CommitmentStatus::Active)
}

/// 用户否掉了 / the user said no.
///
/// 顺手把 `proactive_enabled` 关掉：状态是"现在怎么样"，这个开关是"以后还问不问"。
/// 只改状态的话，下一次提取又会把同一件事推上来。
pub fn dismiss(conn: &Connection, id: &str) -> ObjectResult<TaskCommitment> {
    let updated = set_status(conn, id, CommitmentStatus::Dismissed)?;
    conn.execute(
        "UPDATE task_commitments SET proactive_enabled = 0, updated_at_ms = ?2 WHERE id = ?1",
        params![id, now_ms()],
    )?;
    get(conn, &updated.id)?.ok_or_else(|| ObjectError::NotFound(updated.id))
}

/// 稍后再说 / snooze until a wall-clock moment.
pub fn snooze(conn: &Connection, id: &str, until_ms: i64) -> ObjectResult<TaskCommitment> {
    let updated = set_status(conn, id, CommitmentStatus::Snoozed)?;
    conn.execute(
        "UPDATE task_commitments SET remind_at_ms = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![id, until_ms, now_ms()],
    )?;
    get(conn, &updated.id)?.ok_or_else(|| ObjectError::NotFound(updated.id))
}

/// 完成，必须带证据 / complete, and only with evidence.
///
/// 没有证据的"完成"是一句无法核对的断言。任务系统里最坏的失败模式就是一堆看起来
/// 做完了、其实没人知道有没有做的事——所以这里宁可报错。
pub fn complete(
    conn: &Connection,
    id: &str,
    completion_evidence_id: &str,
) -> ObjectResult<TaskCommitment> {
    if completion_evidence_id.trim().is_empty() {
        return Err(ObjectError::Search(
            "completing a commitment requires completion evidence".to_string(),
        ));
    }
    let exists: Option<String> = conn
        .query_row(
            "SELECT id FROM evidence WHERE id = ?1",
            params![completion_evidence_id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(ObjectError::NotFound(completion_evidence_id.to_string()));
    }

    let updated = set_status(conn, id, CommitmentStatus::Done)?;
    conn.execute(
        "UPDATE task_commitments SET completion_evidence_id = ?2, updated_at_ms = ?3
         WHERE id = ?1",
        params![id, completion_evidence_id, now_ms()],
    )?;
    get(conn, &updated.id)?.ok_or_else(|| ObjectError::NotFound(updated.id))
}

/// 过了截止时间还没做的转成 expired / time out what nobody acted on.
///
/// 存在的理由是"过期任务不能持续打扰"。一条永远停在 `active` 的逾期任务会一直进
/// 提醒候选集，那就是骚扰。
pub fn expire_overdue(conn: &Connection, now: i64, grace_ms: i64) -> ObjectResult<usize> {
    let cutoff = now - grace_ms;
    let changed = conn.execute(
        "UPDATE task_commitments
         SET status = 'expired', updated_at_ms = ?2
         WHERE status IN ('proposed', 'active', 'snoozed')
           AND due_at_ms IS NOT NULL
           AND due_at_ms < ?1",
        params![cutoff, now],
    )?;
    Ok(changed)
}

// ── 主动提醒的闸门 / the gate in front of every proactive nudge ──────────────

/// 提醒策略 / when the app is allowed to speak first.
#[derive(Debug, Clone, PartialEq)]
pub struct NotifyPolicy {
    /// 总开关。false = 一条都不提醒。
    pub enabled: bool,
    /// 免打扰起始小时（本地时间，0-23，含）。
    pub quiet_from_hour: u32,
    /// 免打扰结束小时（本地时间，0-23，不含）。
    pub quiet_to_hour: u32,
    /// 每天最多几条。
    pub max_per_day: i64,
    /// 两条提醒之间的最小间隔。
    pub min_gap_ms: i64,
}

impl Default for NotifyPolicy {
    /// 默认值一律偏安静 / the defaults lean quiet.
    ///
    /// 一个刚装好的应用不该先开口。默认关闭总开关，用户打开的那一刻才算同意。
    fn default() -> Self {
        Self {
            enabled: false,
            quiet_from_hour: 22,
            quiet_to_hour: 8,
            max_per_day: 3,
            min_gap_ms: 4 * 3_600_000,
        }
    }
}

/// 从 `app_settings` 读策略 / load the policy the user actually configured.
///
/// 读不到就用默认值，而不是"当作全部允许"。设置项丢了不该变成开始骚扰。
pub fn load_policy(conn: &Connection) -> NotifyPolicy {
    let get = |key: &str| crate::db::schema::get_setting(conn, key).ok().flatten();
    let mut policy = NotifyPolicy::default();

    if let Some(v) = get("proactive_enabled") {
        policy.enabled = v == "true" || v == "1";
    }
    // 格式 `22-8`：晚 10 点到早 8 点安静。
    if let Some(v) = get("proactive_quiet_hours") {
        if let Some((from, to)) = v.split_once('-') {
            if let (Ok(from), Ok(to)) = (from.trim().parse::<u32>(), to.trim().parse::<u32>()) {
                if from < 24 && to < 24 {
                    policy.quiet_from_hour = from;
                    policy.quiet_to_hour = to;
                }
            }
        }
    }
    if let Some(v) = get("proactive_max_per_day") {
        if let Ok(n) = v.trim().parse::<i64>() {
            policy.max_per_day = n.max(0);
        }
    }
    if let Some(v) = get("proactive_min_gap_minutes") {
        if let Ok(n) = v.trim().parse::<i64>() {
            policy.min_gap_ms = n.max(0) * 60_000;
        }
    }
    policy
}

impl NotifyPolicy {
    /// 现在是免打扰时段吗 / is this hour inside the quiet window.
    ///
    /// 跨午夜要单独算：`22-8` 表示 22、23、0…7，而不是空集。这行反了的话免打扰
    /// 会变成"只在白天安静"。
    pub fn is_quiet_hour(&self, hour: u32) -> bool {
        if self.quiet_from_hour == self.quiet_to_hour {
            return false;
        }
        if self.quiet_from_hour < self.quiet_to_hour {
            hour >= self.quiet_from_hour && hour < self.quiet_to_hour
        } else {
            hour >= self.quiet_from_hour || hour < self.quiet_to_hour
        }
    }
}

/// 为什么这一轮没有提醒 / why nothing was surfaced.
///
/// 拿到理由而不是一个空列表：静默失败的克制机制没法验证，也没法向用户解释。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Silenced {
    /// 用户关掉了主动提醒。
    Disabled,
    /// 免打扰时段。
    QuietHours(u32),
    /// 今天已经到量。
    DailyCap(i64),
    /// 距离上一条太近。
    TooSoon { since_ms: i64 },
}

/// 这一轮该提醒哪些 / which commitments may be surfaced right now.
///
/// 四道闸门按"最便宜、最不容争辩"的顺序判：总开关 → 免打扰 → 日上限 → 最小间隔。
/// 任何一道拦住就返回 `Err(Silenced)`，调用方能如实说出原因。
pub fn due_notifications(
    conn: &Connection,
    policy: &NotifyPolicy,
    now: i64,
    local_hour: u32,
    limit: usize,
) -> ObjectResult<Result<Vec<TaskCommitment>, Silenced>> {
    if !policy.enabled {
        return Ok(Err(Silenced::Disabled));
    }
    if policy.is_quiet_hour(local_hour) {
        return Ok(Err(Silenced::QuietHours(local_hour)));
    }

    let day_start = now - 86_400_000;
    let today: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task_commitments WHERE last_notified_at_ms >= ?1",
        params![day_start],
        |r| r.get(0),
    )?;
    if today >= policy.max_per_day {
        return Ok(Err(Silenced::DailyCap(today)));
    }

    let last: Option<i64> = conn.query_row(
        "SELECT MAX(last_notified_at_ms) FROM task_commitments",
        [],
        |r| r.get(0),
    )?;
    if let Some(last) = last {
        let since = now - last;
        if since < policy.min_gap_ms {
            return Ok(Err(Silenced::TooSoon { since_ms: since }));
        }
    }

    // 只有还开着提醒、还没结掉、且到点了的才进候选。`expired` / `done` /
    // `dismissed` 一律不在其中——那正是"不能持续打扰"的落点。
    let rows = query(
        conn,
        "WHERE proactive_enabled = 1
           AND status IN ('proposed', 'active', 'snoozed')
           AND COALESCE(remind_at_ms, due_at_ms) IS NOT NULL
           AND COALESCE(remind_at_ms, due_at_ms) <= ?1
         ORDER BY priority DESC, COALESCE(remind_at_ms, due_at_ms)
         LIMIT ?2",
        params![now, limit as i64],
    )?;
    Ok(Ok(rows))
}

/// 记下"这条提醒过了" / record that we spoke about this one.
///
/// 必须在真的把提醒交出去之后调。不调的话频率上限永远不会推进，四道闸门里的两道
/// 就形同虚设。
pub fn record_notified(conn: &Connection, id: &str, now: i64) -> ObjectResult<()> {
    conn.execute(
        "UPDATE task_commitments
         SET last_notified_at_ms = ?2, notify_count = notify_count + 1, updated_at_ms = ?2
         WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// 本地小时数 / the local hour, for the quiet-hours check.
///
/// 单独一个函数是为了让 [`NotifyPolicy::is_quiet_hour`] 能被确定性地测——把
/// `Local::now()` 埋进判断里，那条跨午夜的逻辑就只能靠运行时机碰运气验证。
pub fn local_hour_now() -> u32 {
    use chrono::Timelike;
    chrono::Local::now().hour()
}

// ── 结果回流 / returning the result to where the task came from ──────────────

/// 完成一条承诺并把结果回流 / complete a commitment and route its result back.
///
/// "只把状态改成 done"是这套东西最容易滑向的失败模式：任务列表干净了，但那份工作
/// 的产出没有落在任何人下次会看到的地方。所以这里做三件事：
///
/// 1. 把结果本身登记成一条内容寻址的证据（`summary` 是内容，checksum 由证据层算）；
/// 2. 绑到源对象上（`role = "supports"`），让那篇笔记的证据列表里出现这次产出；
/// 3. 用这条证据完成任务，并留下一条带 `return_target` 的审计事件。
///
/// **刻意不改用户的 Markdown。** scheduler 里没有审批闸门，在那里直接写文件就是
/// Agent 写入绕过 ChangeSet。要落到笔记正文里，走 `write_guard` 那条路。
pub fn deliver_result(
    conn: &Connection,
    id: &str,
    summary: &str,
    actor: &str,
) -> ObjectResult<TaskCommitment> {
    let commitment = get(conn, id)?.ok_or_else(|| ObjectError::NotFound(id.to_string()))?;
    if summary.trim().is_empty() {
        return Err(ObjectError::Search(
            "a commitment result needs a summary — an empty result is not a result".to_string(),
        ));
    }

    let evidence_id = evidence::record_evidence(
        conn,
        evidence::NewEvidence {
            source_type: "commitment".to_string(),
            source_id: commitment.id.clone(),
            locator: commitment.return_target.clone(),
            excerpt: Some(summary.to_string()),
            author: Some(actor.to_string()),
            extraction_model: None,
            pipeline_version: None,
        },
    )?;

    if let Some(object_id) = &commitment.object_id {
        evidence::attach_evidence(conn, object_id, &evidence_id, "supports", 1.0)?;
    }

    let done = complete(conn, id, &evidence_id)?;

    object_store::record_audit(
        conn,
        actor,
        "commitment_result",
        "done",
        commitment.object_id.as_deref(),
        None,
        None,
        None,
        commitment.return_target.as_deref(),
        None,
        None,
        Some(
            &serde_json::json!({
                "commitment_id": commitment.id,
                "return_target": commitment.return_target,
                "evidence_id": evidence_id,
            })
            .to_string(),
        ),
    )?;

    Ok(done)
}

// ── 从笔记里提取 / harvesting commitments from the vault ─────────────────────

/// 一次扫描的结果 / what one scan found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanReport {
    /// 扫到的带日期待办条数。
    pub found: usize,
    /// 新建的承诺条数（去重之后）。
    pub created: usize,
}

/// 扫描笔记里的带日期待办 / harvest dated, unchecked checkboxes from notes.
///
/// ## 为什么只收"带日期"的
///
/// 一个大 vault 里未打勾的方括号可能有上千个，全收进来收件箱当天就废了。带日期的
/// 待办是**用户自己写下了时间承诺**的那一批：信号明确、可核对、提醒起来有意义。
///
/// 没有日期的 open loop 需要判断"这算不算一件待办"，那是模型的活，不是正则的活。
/// 这里不假装能做到——留给后面接 extractor，而不是先塞一堆噪音进来。
///
/// ## 为什么是 proposed
///
/// 扫出来的一律进 `proposed`：这是"默认创建 proposed/inbox，不代表用户执行"的落点。
/// 用户点了接受才变 `active`。
pub fn scan_notes(conn: &Connection, limit: usize) -> ObjectResult<ScanReport> {
    let mut stmt = conn.prepare(
        "SELECT c.file_path, c.content FROM chunks c
         WHERE c.content LIKE '%- [ ]%'
         ORDER BY c.file_path, c.chunk_index",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut report = ScanReport::default();
    for (path, content) in rows {
        for line in content.lines() {
            if report.created >= limit {
                return Ok(report);
            }
            let Some(task) = parse_dated_todo(line) else { continue };
            report.found += 1;

            let existed = find_by_dedupe_key(conn, &dedupe_for(&task.title))?.is_some();

            let evidence_id = evidence::record_evidence(
                conn,
                evidence::NewEvidence {
                    source_type: "file".to_string(),
                    source_id: path.clone(),
                    locator: Some(path.clone()),
                    excerpt: Some(line.trim().to_string()),
                    author: None,
                    extraction_model: None,
                    pipeline_version: None,
                },
            )?;

            let object_id = object_store::find_by_source(conn, &SourceRef::file(&path))?
                .map(|o| o.id);

            let mut req = NewCommitment::new("deadline", task.title.clone());
            req.object_id = object_id;
            req.source = Some(SourceRef::file(&path));
            req.evidence_ids = vec![evidence_id];
            req.due_at_ms = Some(task.due_at_ms);
            // 提前一天提醒，但不早于"现在"——补录一条昨天到期的待办不该立刻弹窗，
            // 它已经逾期了，`expire_overdue` 会处理。
            req.remind_at_ms = Some(task.due_at_ms - 86_400_000);
            req.return_target = Some(path.clone());
            req.dedupe_key = Some(dedupe_for(&task.title));

            propose(conn, &req)?;
            if !existed {
                report.created += 1;
            }
        }
    }
    Ok(report)
}

fn dedupe_for(title: &str) -> String {
    let normalized: String = title.chars().filter(|c| c.is_alphanumeric()).collect();
    format!("deadline::{}", normalized.to_lowercase())
}

/// 一行待办解析出来的东西 / one parsed checkbox line.
struct DatedTodo {
    title: String,
    due_at_ms: i64,
}

/// 解析一行 Markdown 待办 / parse one Markdown task line.
///
/// 只认未打勾的 `- [ ]`（`- [x]` 是已完成，重新提出来就是骚扰），且行内必须有一个
/// `YYYY-MM-DD`。日期按**本地时区的当天结束**算：写下"8 月 30 日"的人指的是那天
/// 结束前，而不是那天零点——按零点算会让当天写下的待办一出生就逾期。
fn parse_dated_todo(line: &str) -> Option<DatedTodo> {
    let trimmed = line.trim_start();
    let rest = trimmed
        .strip_prefix("- [ ]")
        .or_else(|| trimmed.strip_prefix("* [ ]"))
        .or_else(|| trimmed.strip_prefix("+ [ ]"))?;

    let body = rest.trim();
    if body.is_empty() {
        return None;
    }

    let date = find_iso_date(body)?;
    let due = date
        .and_hms_opt(23, 59, 59)?
        .and_local_timezone(chrono::Local)
        .single()?;

    Some(DatedTodo {
        title: body.to_string(),
        due_at_ms: due.timestamp_millis(),
    })
}

/// 找出行内第一个 `YYYY-MM-DD` / the first ISO date in the line.
///
/// 手写而不是上正则：这条扫描跑在每个 chunk 的每一行上，一个 10 字符的窗口比编译
/// 一个正则再回溯便宜得多，逻辑也短得能一眼看完。
///
/// 按 `char` 而不是按字节滑窗：中文待办里 `- [ ] 交季度总结 2026-08-30` 的前半段是
/// 多字节的，按字节切窗口会切在半个汉字上。
fn find_iso_date(text: &str) -> Option<chrono::NaiveDate> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 10 {
        return None;
    }
    for start in 0..=chars.len() - 10 {
        let w = &chars[start..start + 10];
        let digits_ok = w[0..4].iter().all(|c| c.is_ascii_digit())
            && w[4] == '-'
            && w[5..7].iter().all(|c| c.is_ascii_digit())
            && w[7] == '-'
            && w[8..10].iter().all(|c| c.is_ascii_digit());
        if !digits_ok {
            continue;
        }
        let window: String = w.iter().collect();
        if let Ok(date) = chrono::NaiveDate::parse_from_str(&window, "%Y-%m-%d") {
            return Some(date);
        }
    }
    None
}





