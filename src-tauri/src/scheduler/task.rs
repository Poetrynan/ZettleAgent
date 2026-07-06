use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use rusqlite::Connection;
use crate::scheduler::SchedulerConfig;

#[allow(async_fn_in_trait)]
pub trait SchedulerTask: Send + Sync {
    fn name(&self) -> &str;
    
    async fn run(
        &self,
        db: &Arc<std::sync::Mutex<Connection>>,
        config: &SchedulerConfig,
        running: Arc<AtomicBool>,
        app: Option<tauri::AppHandle>,
        force: bool,
        methodology: String,
        path_prefix: Option<String>,
    ) -> anyhow::Result<(usize, usize, usize)>;
}
