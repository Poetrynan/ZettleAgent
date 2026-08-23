use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ZettelError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("LLM request failed: {0}")]
    Llm(String),

    #[error("System error: {0}")]
    System(String),

    #[error("Scheduler error: {0}")]
    Scheduler(String),

    #[error("Mutex poison error")]
    Poison,

    /// 乐观并发失败 / an optimistic-concurrency failure.
    ///
    /// 与 `Db`/`System` 分开是为了让前端能分支：冲突不该重试，而要让用户在
    /// "基于新内容重新生成"和"放弃"之间选。
    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Tauri error: {0}")]
    Tauri(#[from] tauri::Error),
}

impl From<crate::knowledge::object_store::ObjectError> for ZettelError {
    fn from(e: crate::knowledge::object_store::ObjectError) -> Self {
        use crate::knowledge::object_store::ObjectError;
        match e {
            ObjectError::VersionConflict { .. } | ObjectError::ChecksumConflict { .. } => {
                ZettelError::Conflict(e.to_string())
            }
            ObjectError::Db(inner) => ZettelError::Db(inner),
            other => ZettelError::System(other.to_string()),
        }
    }
}

impl<T> From<std::sync::PoisonError<T>> for ZettelError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        ZettelError::Poison
    }
}

impl From<anyhow::Error> for ZettelError {
    fn from(e: anyhow::Error) -> Self {
        ZettelError::System(e.to_string())
    }
}

impl Serialize for ZettelError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
