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

    #[error("Tauri error: {0}")]
    Tauri(#[from] tauri::Error),
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
