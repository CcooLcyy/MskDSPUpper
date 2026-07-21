use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing_subscriber::fmt::MakeWriter;

const LOG_FILE_NAME: &str = "mskdsp-upper.log";
const MAX_LOG_FILE_SIZE: u64 = 10 * 1024 * 1024;
const LOG_RETENTION: Duration = Duration::from_secs(60 * 24 * 60 * 60);

struct LogFileState {
    file: Option<File>,
    path: PathBuf,
    length: u64,
}

#[derive(Clone)]
struct SharedLogFile(Arc<Mutex<LogFileState>>);

struct LogFileWriter(Arc<Mutex<LogFileState>>);

impl LogFileState {
    fn open(path: PathBuf) -> io::Result<Self> {
        let file = open_log_file(&path)?;
        let length = file.metadata()?.len();
        Ok(Self {
            file: Some(file),
            path,
            length,
        })
    }

    fn rotate(&mut self) -> io::Result<()> {
        if let Some(mut file) = self.file.take() {
            if let Err(error) = file.flush() {
                self.file = Some(file);
                return Err(error);
            }
        }

        if let Err(error) = archive_log_file(&self.path, SystemTime::now()) {
            self.file = open_log_file(&self.path).ok();
            return Err(error);
        }

        self.file = Some(open_log_file(&self.path)?);
        self.length = 0;
        Ok(())
    }

    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }

        let buffer_length = u64::try_from(buffer.len()).unwrap_or(u64::MAX);
        if self.length >= MAX_LOG_FILE_SIZE
            || (self.length > 0 && self.length.saturating_add(buffer_length) > MAX_LOG_FILE_SIZE)
        {
            self.rotate()?;
        }

        // A single Write call may itself be larger than the limit. Returning a
        // partial write lets Write::write_all rotate before writing the remainder.
        let available = (MAX_LOG_FILE_SIZE - self.length) as usize;
        let write_length = buffer.len().min(available);
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "日志文件未打开"))?;
        let written = file.write(&buffer[..write_length])?;
        self.length = self.length.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "日志文件未打开"))?
            .flush()
    }
}

impl SharedLogFile {
    fn lock(&self) -> io::Result<MutexGuard<'_, LogFileState>> {
        self.0
            .lock()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "日志文件锁已损坏"))
    }
}

impl<'a> MakeWriter<'a> for SharedLogFile {
    type Writer = LogFileWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogFileWriter(Arc::clone(&self.0))
    }
}

impl Write for LogFileWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let shared = SharedLogFile(Arc::clone(&self.0));
        let result = shared.lock()?.write(buffer);
        result
    }

    fn flush(&mut self) -> io::Result<()> {
        let shared = SharedLogFile(Arc::clone(&self.0));
        let result = shared.lock()?.flush();
        result
    }
}

fn open_log_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

fn archive_log_file(log_path: &Path, timestamp: SystemTime) -> io::Result<PathBuf> {
    let elapsed = timestamp.duration_since(UNIX_EPOCH).unwrap_or_default();
    let base_name = format!(
        "{LOG_FILE_NAME}.{}-{:09}-{}",
        elapsed.as_secs(),
        elapsed.subsec_nanos(),
        std::process::id()
    );
    let directory = log_path.parent().unwrap_or_else(|| Path::new("."));

    for sequence in 0_u64.. {
        let file_name = if sequence == 0 {
            base_name.clone()
        } else {
            format!("{base_name}-{sequence}")
        };
        let archive_path = directory.join(file_name);
        if archive_path.exists() {
            continue;
        }

        fs::rename(log_path, &archive_path)?;
        return Ok(archive_path);
    }

    unreachable!("rotation sequence is unbounded")
}

fn is_expired(modified: SystemTime, now: SystemTime, retention: Duration) -> bool {
    now.duration_since(modified)
        .map(|age| age > retention)
        .unwrap_or(false)
}

fn cleanup_history_at(
    log_directory: &Path,
    now: SystemTime,
    retention: Duration,
) -> io::Result<()> {
    let history_prefix = format!("{LOG_FILE_NAME}.");
    for entry in fs::read_dir(log_directory)? {
        let Ok(entry) = entry else {
            continue;
        };
        let file_name = entry.file_name();
        if !file_name.to_string_lossy().starts_with(&history_prefix) {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if metadata.is_file() && is_expired(modified, now, retention) {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

fn cleanup_history(log_directory: &Path) -> io::Result<()> {
    cleanup_history_at(log_directory, SystemTime::now(), LOG_RETENTION)
}

fn rotate_oversized_log(log_path: &Path) -> io::Result<Option<PathBuf>> {
    match fs::metadata(log_path) {
        Ok(metadata) if metadata.len() > MAX_LOG_FILE_SIZE => {
            archive_log_file(log_path, SystemTime::now()).map(Some)
        }
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn init(log_directory: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(&log_directory).map_err(|error| {
        format!(
            "创建上位机日志目录失败: {}，原因={error}",
            log_directory.display()
        )
    })?;

    let log_path = log_directory.join(LOG_FILE_NAME);
    rotate_oversized_log(&log_path).map_err(|error| {
        format!(
            "轮转上位机日志文件失败: {}，原因={error}",
            log_path.display()
        )
    })?;
    cleanup_history(&log_directory).map_err(|error| {
        format!(
            "清理上位机历史日志失败: {}，原因={error}",
            log_directory.display()
        )
    })?;
    let log_state = LogFileState::open(log_path.clone()).map_err(|error| {
        format!(
            "打开上位机日志文件失败: {}，原因={error}",
            log_path.display()
        )
    })?;

    let writer = SharedLogFile(Arc::new(Mutex::new(log_state)));
    tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(false)
        .with_max_level(tracing::Level::INFO)
        .try_init()
        .map_err(|error| format!("初始化上位机日志订阅器失败: {error}"))?;

    Ok(log_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::FileTimes;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "mskdsp-upper-logging-test-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn open_test_metadata_file(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)
    }

    #[test]
    fn rotates_before_a_write_would_exceed_the_limit() {
        let directory = TestDirectory::new();
        let log_path = directory.0.join(LOG_FILE_NAME);
        let file = open_test_metadata_file(&log_path).unwrap();
        file.set_len(MAX_LOG_FILE_SIZE - 2).unwrap();
        drop(file);

        let mut state = LogFileState::open(log_path.clone()).unwrap();
        assert_eq!(state.write(b"four").unwrap(), 4);
        state.flush().unwrap();

        assert_eq!(fs::metadata(&log_path).unwrap().len(), 4);
        let archives: Vec<_> = fs::read_dir(&directory.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mskdsp-upper.log.")
            })
            .collect();
        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0].metadata().unwrap().len(), MAX_LOG_FILE_SIZE - 2);
    }

    #[test]
    fn a_single_large_write_keeps_every_file_within_the_limit() {
        let directory = TestDirectory::new();
        let log_path = directory.0.join(LOG_FILE_NAME);
        let state = LogFileState::open(log_path.clone()).unwrap();
        let shared = Arc::new(Mutex::new(state));
        let mut writer = LogFileWriter(shared);
        let buffer = vec![b'x'; MAX_LOG_FILE_SIZE as usize + 1];

        writer.write_all(&buffer).unwrap();
        writer.flush().unwrap();

        assert_eq!(fs::metadata(&log_path).unwrap().len(), 1);
        let archives: Vec<_> = fs::read_dir(&directory.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mskdsp-upper.log.")
            })
            .collect();
        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0].metadata().unwrap().len(), MAX_LOG_FILE_SIZE);
    }

    #[test]
    fn startup_rotation_only_rotates_logs_over_the_limit() {
        let directory = TestDirectory::new();
        let log_path = directory.0.join(LOG_FILE_NAME);
        let file = open_test_metadata_file(&log_path).unwrap();
        file.set_len(MAX_LOG_FILE_SIZE).unwrap();
        drop(file);
        assert!(rotate_oversized_log(&log_path).unwrap().is_none());

        let file = open_test_metadata_file(&log_path).unwrap();
        file.set_len(MAX_LOG_FILE_SIZE + 1).unwrap();
        drop(file);
        let archive = rotate_oversized_log(&log_path).unwrap().unwrap();
        assert!(!log_path.exists());
        assert_eq!(fs::metadata(archive).unwrap().len(), MAX_LOG_FILE_SIZE + 1);
    }

    #[test]
    fn archive_names_do_not_replace_an_existing_file() {
        let directory = TestDirectory::new();
        let log_path = directory.0.join(LOG_FILE_NAME);
        fs::write(&log_path, b"new log").unwrap();
        let timestamp = UNIX_EPOCH + Duration::from_secs(123);
        let occupied = directory.0.join(format!(
            "{LOG_FILE_NAME}.123-000000000-{}",
            std::process::id()
        ));
        fs::write(&occupied, b"existing log").unwrap();

        let archive = archive_log_file(&log_path, timestamp).unwrap();

        assert_eq!(fs::read(occupied).unwrap(), b"existing log");
        assert!(archive.ends_with(format!(
            "{LOG_FILE_NAME}.123-000000000-{}-1",
            std::process::id()
        )));
        assert_eq!(fs::read(archive).unwrap(), b"new log");
    }

    #[test]
    fn cleanup_only_removes_expired_history_files() {
        let directory = TestDirectory::new();
        let expired = directory.0.join(format!("{LOG_FILE_NAME}.old"));
        let current = directory.0.join(format!("{LOG_FILE_NAME}.current"));
        let active = directory.0.join(LOG_FILE_NAME);
        let unrelated = directory.0.join("other.log");
        for path in [&expired, &current, &active, &unrelated] {
            fs::write(path, b"log").unwrap();
        }

        let now = SystemTime::now();
        let expired_at = now - LOG_RETENTION - Duration::from_secs(1);
        open_test_metadata_file(&expired)
            .unwrap()
            .set_times(FileTimes::new().set_modified(expired_at))
            .unwrap();
        cleanup_history_at(&directory.0, now, LOG_RETENTION).unwrap();

        assert!(!expired.exists());
        assert!(current.exists());
        assert!(active.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn future_timestamps_are_not_expired() {
        let now = UNIX_EPOCH + Duration::from_secs(100);
        assert!(!is_expired(
            now + Duration::from_secs(1),
            now,
            LOG_RETENTION
        ));
    }
}
