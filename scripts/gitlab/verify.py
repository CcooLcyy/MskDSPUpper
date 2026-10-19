"""Run independent frontend and Rust verification, keeping both logs and timings."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def run_verification():
    logs = ROOT / "package/logs"
    logs.mkdir(parents=True, exist_ok=True)
    processes = set()
    lock = threading.Lock()
    cancelled = threading.Event()
    result = {"started_at": utc_now(), "branches": {}}
    started = time.monotonic()

    def stop_process(process):
        if process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW, check=False)
        else:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        process.wait()

    def branch(name, commands):
        data = {"started_at": utc_now(), "steps": []}
        branch_started = time.monotonic()
        code = 0
        with (logs / f"verify-{name}.log").open("w", encoding="utf-8", newline="\n") as log:
            def emit(message):
                line = f"[{name}] {message}"
                with lock:
                    print(line, flush=True)
                log.write(line + "\n")
                log.flush()

            for label, arguments in commands:
                if cancelled.is_set():
                    code = 1
                    break
                step = {"name": label, "started_at": utc_now()}
                step_started = time.monotonic()
                emit(f"START {label}")
                process = None
                try:
                    executable = shutil.which(arguments[0])
                    if not executable:
                        raise FileNotFoundError(f"Required tool missing: {arguments[0]}")
                    command = [executable, *arguments[1:]]
                    options = {}
                    if os.name == "nt":
                        options["creationflags"] = subprocess.CREATE_NO_WINDOW
                        if Path(executable).suffix.lower() in (".cmd", ".bat"):
                            command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c",
                                       subprocess.list2cmdline(command)]
                    else:
                        options["start_new_session"] = True
                    with lock:
                        if cancelled.is_set():
                            raise RuntimeError("Verification interrupted")
                        process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                                                   stderr=subprocess.STDOUT, text=True,
                                                   encoding="utf-8", errors="replace", **options)
                        processes.add(process)
                    for line in process.stdout:
                        emit(line.rstrip("\r\n"))
                    code = process.wait()
                except Exception as error:
                    emit(f"ERROR {type(error).__name__}: {error}")
                    code = 1
                    if process is not None:
                        stop_process(process)
                finally:
                    if process is not None:
                        with lock:
                            processes.discard(process)
                        if process.stdout is not None:
                            process.stdout.close()
                step.update(finished_at=utc_now(), elapsed_seconds=round(time.monotonic()-step_started, 3),
                            exit_code=code)
                data["steps"].append(step)
                emit(f"END {label}: exit={code}, seconds={step['elapsed_seconds']}")
                if code:
                    break
        data.update(finished_at=utc_now(), elapsed_seconds=round(time.monotonic()-branch_started, 3),
                    exit_code=code)
        result["branches"][name] = data
        return code

    executor = ThreadPoolExecutor(max_workers=2)
    interrupted = False
    futures = []
    try:
        futures = [executor.submit(branch, "frontend", [
            ("dependencies", [sys.executable, "-B", "scripts/gitlab/ensure_node_modules.py"]),
            ("workflow", ["npm", "run", "test:workflow"]),
            ("offline", ["npm", "run", "test:offline"]),
            ("lint", ["npm", "run", "lint"]),
        ]), executor.submit(branch, "rust", [
            ("cargo-test", ["cargo", "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
                            "--target", "x86_64-pc-windows-msvc"]),
        ])]
        # Wait for both branches even after a failure; no verification child survives into packaging.
        codes = [future.result() for future in futures]
    except BaseException:
        interrupted = True
        cancelled.set()
        with lock:
            active = list(processes)
        for process in active:
            stop_process(process)
        raise
    finally:
        executor.shutdown(wait=True)
        result.update(finished_at=utc_now(), elapsed_seconds=round(time.monotonic()-started, 3),
                      exit_code=1 if interrupted else (0 if all(f.done() and not f.exception() and f.result() == 0
                                                              for f in futures) else 1))
        (logs / "verify-timing.json").write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n",
                                                encoding="utf-8")
    return 0 if all(code == 0 for code in codes) else 1


if __name__ == "__main__":
    sys.exit(run_verification())
