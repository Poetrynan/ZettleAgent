use std::fs::File;
use std::path::Path;
use std::io::Write;
use std::time::Duration;
use std::thread;

/// Safely write content to a file by acquiring an exclusive lock first.
/// If the file is locked by another process, it will block until the lock is acquired.
pub fn safe_write(path: &Path, content: &str) -> anyhow::Result<()> {
    let mut file = File::options()
        .write(true)
        .create(true)
        .open(path)?;

    // Acquire an exclusive lock (blocks until lock is acquired)
    file.lock()?;

    // Truncate the file since we opened it without truncate to avoid erasing contents before locking
    file.set_len(0)?;
    file.write_all(content.as_bytes())?;
    file.flush()?;

    // Lock is released automatically when `file` is dropped.
    Ok(())
}

/// Attempt to write content to a file without blocking.
/// Returns an error if the file is currently locked.
#[allow(dead_code)]
pub fn safe_write_timeout(path: &Path, content: &str, retries: usize, delay: Duration) -> anyhow::Result<()> {
    let mut file = File::options()
        .write(true)
        .create(true)
        .open(path)?;

    let mut lock_acquired = false;
    for _ in 0..retries {
        match file.try_lock() {
            Ok(()) => {
                lock_acquired = true;
                break;
            }
            Err(_e) => {
                // try_lock returns a TryLockError, not io::Error
                // Just retry after delay
                thread::sleep(delay);
            }
        }
    }

    if !lock_acquired {
        return Err(anyhow::anyhow!("Failed to acquire file lock after multiple attempts"));
    }

    file.set_len(0)?;
    file.write_all(content.as_bytes())?;
    file.flush()?;
    Ok(())
}
