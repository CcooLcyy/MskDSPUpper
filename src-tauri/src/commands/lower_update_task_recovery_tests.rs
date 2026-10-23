use super::*;
use std::process::Command;

const ID: &str = "f727e860-5923-4a50-8e2a-c4e114530bbb";

fn unquote(value: &str) -> String {
    value
        .strip_prefix('\'')
        .unwrap()
        .strip_suffix('\'')
        .unwrap()
        .replace("'\\''", "'")
}

fn run_python(script: &str) -> std::process::Output {
    Command::new(if cfg!(windows) { "python" } else { "python3" })
        .args(["-B", "-c", script])
        .env("PYTHONIOENCODING", "utf-8")
        .output()
        .expect("运行生成命令的 Python 隔离测试")
}

// 执行真正生成的内存命令，只替换外部系统观察，任何 mkdir 都使测试失败。
#[test]
fn query_generated_command_is_readonly_and_never_schedules() {
    let command = readonly_command("query", Some(ID)).unwrap();
    assert!(!command.contains("; exec python3"));
    assert!(!command.contains("LOWER_UPDATE_TASK_REJECTED:"));
    let mut source = unquote(command.strip_prefix("exec python3 -B -c ").unwrap());
    let setup = r#"from pathlib import Path
import tempfile
temporary=tempfile.TemporaryDirectory()
root=Path(temporary.name)/'missing-tasks'
manager=namespace['ReadOnlyTaskManager']
class Observer:
    def assert_idle(self): pass
    def schedule(self,*args): raise AssertionError('只读查询不能调度')
namespace['ReadOnlyTaskManager']=lambda:manager(root=root,backend=Observer(),secure=False)
namespace['os'].geteuid=lambda:0
def forbidden(*args,**kwargs): raise AssertionError('只读查询不能创建目录')
Path.mkdir=forbidden
"#;
    source = source.replace(
        "sys.exit(namespace['readonly_main']",
        &format!("{setup}\nsys.exit(namespace['readonly_main']"),
    );
    let script = format!("try:\n    exec({})\nexcept SystemExit as status:\n    assert status.code == 1\nassert not root.exists()\n", serde_json::to_string(&source).unwrap());
    let output = run_python(&script);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("LOWER_UPDATE_TASK_NOT_FOUND:"));
}

// 预检实际加载受信源码，目录检查缺失时也不得创建安装助手或任务根目录。
#[test]
fn preflight_generated_command_never_installs_helper() {
    let command = readonly_command("preflight", None).unwrap();
    let mut source = unquote(command.strip_prefix("exec python3 -B -c ").unwrap());
    let setup = r#"checked=[]
namespace['os'].geteuid=lambda:0
namespace['ensure_secure_existing']=lambda path:checked.append(str(path))
namespace['Backend'].environment_preflight=lambda self:None
def forbidden(*args,**kwargs): raise AssertionError('预检不能创建目录')
namespace['Path'].mkdir=forbidden
namespace['Backend'].schedule=forbidden
"#;
    source = source.replace(
        "sys.exit(namespace['readonly_main']",
        &format!("{setup}\nsys.exit(namespace['readonly_main']"),
    );
    let script = format!("try:\n    exec({})\nexcept SystemExit as status:\n    assert status.code == 0\nassert len(checked) == 2\n", serde_json::to_string(&source).unwrap());
    let output = run_python(&script);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"ok\": true"));
}

// bootstrap 的权限拒绝发生在首次目录写入前，且明确拒绝标记不能覆盖后续 helper 执行。
#[test]
fn bootstrap_permission_rejection_is_explicit_and_before_directory_creation() {
    let command = helper_command(&["submit", "--operation-id", ID]).unwrap();
    let quoted = command
        .strip_prefix("set -e; python3 -c ")
        .unwrap()
        .split_once("; exec python3 ")
        .unwrap()
        .0;
    let source = unquote(quoted);
    let script = format!(
        r#"import os,stat
from unittest.mock import patch
from types import SimpleNamespace
info=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o775)
with patch('os.lstat',return_value=info),patch('os.mkdir',side_effect=AssertionError('拒绝前不应创建目录')):
    try: exec({})
    except SystemExit as status: assert status.code == 1
    else: raise AssertionError('权限异常应被明确拒绝')
"#,
        serde_json::to_string(&source).unwrap()
    );
    let output = run_python(&script);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("LOWER_UPDATE_TASK_REJECTED:"));
}

// 平台解析本身不返回时，也必须被整个查询的总时限约束。
#[tokio::test]
async fn query_deadline_includes_pending_target_resolution() {
    let observer = UpdateSshObserver::new(ID, "查询", "原设备", &["认证秘密", "提权秘密"]);
    let result: Result<(), String> =
        with_update_deadline(&observer, Duration::from_millis(5), async {
            observer.stage("目标解析");
            std::future::pending().await
        })
        .await;
    let error = result.unwrap_err();
    assert!(error.contains("目标解析"));
    assert!(error.contains("超时"));
    assert!(!error.contains("LOWER_UPDATE_TASK_REJECTED:"));
}

// 传输和超时错误必须标明当前阶段，同时清除返回信息和 WARN 日志中的秘密。
#[tokio::test]
async fn command_failure_reports_stage_and_redacts_secrets_in_warning() {
    #[derive(Clone)]
    struct Capture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let bytes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let capture = Capture(bytes.clone());
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(move || capture.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let observer = UpdateSshObserver::new(ID, "查询", "原设备", &["ssh-secret", "sudo-secret"]);
    let result: Result<(), String> =
        with_update_deadline(&observer, Duration::from_secs(1), async {
            observer.stage("SSH会话通道");
            Err("连接中断 ssh-secret sudo-secret".into())
        })
        .await;
    let error = result.unwrap_err();
    assert!(error.contains("SSH会话通道"));
    assert!(error.contains("[已隐藏]"));
    let timeout: Result<(), String> =
        with_update_deadline(&observer, Duration::from_millis(5), async {
            observer.stage("SSH响应接收");
            std::future::pending().await
        })
        .await;
    assert!(timeout.unwrap_err().contains("SSH响应接收"));
    let logs = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("WARN"));
    assert!(logs.contains(ID));
    assert!(logs.contains("SSH会话通道"));
    assert!(logs.contains("SSH响应接收"));
    assert!(logs.contains("超时"));
    for secret in ["ssh-secret", "sudo-secret"] {
        assert!(!error.contains(secret));
        assert!(!logs.contains(secret));
    }
}

// 已拿到响应后的清理连接不能让一个已完成的查询继续等待。
#[tokio::test]
async fn completed_response_is_not_blocked_by_disconnect() {
    let observer = UpdateSshObserver::new(ID, "查询", "原设备", &[]);
    let result = complete_without_waiting_for_disconnect(
        42,
        std::future::pending::<Result<(), String>>(),
        &observer,
    );
    assert_eq!(result, 42);
}

// 密码横跨日志尾部裁剪边界时，必须先去密再裁剪，不能保留密码后缀。
#[test]
fn log_redaction_precedes_tail_truncation() {
    let secret = "cross-boundary-password";
    let observer = UpdateSshObserver::new(ID, "查询", "原设备", &[secret]);
    let log = format!("{secret}{}", "x".repeat(MAX_LOG_BYTES - secret.len() / 2));
    let response = serde_json::json!({"operation_id":ID,"phase":"verifying","message":secret,
        "expected_image_id":"sha256:abc", "log_tail":log})
    .to_string();
    let status = parse_status_observed(&response, ID, Some(&observer)).unwrap();
    assert!(!status.log_tail.contains(&secret[secret.len() / 2..]));
    assert_eq!(status.message, "[已隐藏]");
    assert!(status.log_tail.len() <= MAX_LOG_BYTES);
}
