use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use tracing_subscriber::fmt::MakeWriter;

const LOG_FILE_NAME: &str = "mskdsp-upper.log";

#[derive(Clone)]
struct SharedLogFile(Arc<Mutex<std::fs::File>>);

struct LogFileWriter(Arc<Mutex<std::fs::File>>);

impl SharedLogFile {
    fn lock(&self) -> io::Result<MutexGuard<'_, std::fs::File>> {
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
        let mut file = shared.lock()?;
        file.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        let shared = SharedLogFile(Arc::clone(&self.0));
        let mut file = shared.lock()?;
        file.flush()
    }
}

fn executable_directory() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| format!("获取上位机程序路径失败: {error}"))?;
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("上位机程序路径没有父目录: {}", executable.display()))
}

pub fn init() -> Result<PathBuf, String> {
    let log_directory = executable_directory()?.join("logs");
    fs::create_dir_all(&log_directory)
        .map_err(|error| format!("创建上位机日志目录失败: {}，原因={error}", log_directory.display()))?;

    let log_path = log_directory.join(LOG_FILE_NAME);
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("打开上位机日志文件失败: {}，原因={error}", log_path.display()))?;

    let writer = SharedLogFile(Arc::new(Mutex::new(log_file)));
    tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(false)
        .with_max_level(tracing::Level::INFO)
        .try_init()
        .map_err(|error| format!("初始化上位机日志订阅器失败: {error}"))?;

    Ok(log_path)
}
