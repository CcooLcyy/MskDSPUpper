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
