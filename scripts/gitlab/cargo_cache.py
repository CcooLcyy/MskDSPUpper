"""记录上位机 Cargo 缓存归属，并按构建记录回收已知产物。"""
import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid


SCHEMA = 1
PROJECT = "mskdsp-upper"
OWN_CRATES = {"mskdsp_upper", "mskdsp_upper_lib", "build_script_build"}
GENERATION = re.compile(r"(?:verify|package)-[A-Za-z0-9][A-Za-z0-9.+_-]{0,180}\Z")
OWN_HASH = re.compile(r"mskdsp-upper-[a-f0-9]{16}\Z")
OWN_INCREMENTAL = re.compile(r"mskdsp_upper(?:_lib)?-[a-z0-9]+\Z")
OWN_FILE = re.compile(r"(?:lib)?mskdsp_upper(?:_lib)?-[a-f0-9]{16}(?:\.[A-Za-z0-9_-]+)+\Z")


def _checked(path):
    """先查原始路径各层，再解析；拒绝重解析点和向上跳转。"""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("缓存路径必须是无向上跳转的绝对路径")
    for candidate in reversed((path, *path.parents)):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if candidate.is_symlink() or getattr(info, "st_file_attributes", 0) & 1024:
            raise ValueError("缓存路径不能包含符号链接或重解析点")
    return path.resolve()


def _inside(target, path):
    path = _checked(path)
    try:
        relative = path.relative_to(target)
    except ValueError as error:
        raise ValueError("缓存产物超出目标目录") from error
    if not relative.parts:
        raise ValueError("禁止把整个 Cargo 目录作为回收产物")
    return path, relative.as_posix()


def _json(path, value):
    path = _checked(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _read(path):
    return json.loads(_checked(path).read_text(encoding="utf-8"))


def _run_id():
    pipeline = os.environ.get("CI_PIPELINE_ID", "local")
    job = os.environ.get("CI_JOB_ID", "local")
    # 标识仅作为 JSON 键；磁盘记录目录使用确定性的十六进制编码。
    return pipeline + ":" + job


def _run_folder(run):
    return run.encode("utf-8").hex()


def _generation(value):
    if not GENERATION.fullmatch(value):
        raise ValueError("缓存代次标识不合法")
    return value


def _load(target_dir):
    target = _checked(target_dir)
    root = _checked(target / ".upper-cache")
    identity = _read(root / "identity.json")
    if identity != {"schema": SCHEMA, "project": PROJECT, "target_dir": str(target)}:
        raise ValueError("缓存根目录身份不一致")
    state = _read(root / "state.json")
    if (state.get("schema") != SCHEMA or state.get("target_dir") != str(target)
            or not isinstance(state.get("runs"), dict)
            or not isinstance(state.get("generations"), dict)
            or not isinstance(state.get("successes"), list)):
        raise ValueError("缓存状态格式不受支持")
    for name in state["generations"]:
        _generation(name)
    return target, root, state


def _owned(target, path):
    """仅接受当前项目的精确文件或当前项目命名的缓存单元。"""
    path, relative = _inside(target, path)
    parts = Path(relative).parts
    if len(parts) == 3 and parts[:2] == (".upper-cache", "generations"):
        return bool(GENERATION.fullmatch(parts[2]))
    if parts[:1] == ("release",):
        tail = parts[1:]
    elif parts[:2] == ("x86_64-pc-windows-msvc", "release"):
        tail = parts[2:]
    else:
        return False
    if len(tail) == 2:
        if tail[0] in (".fingerprint", "build"):
            return bool(OWN_HASH.fullmatch(tail[1]))
        if tail[0] == "incremental":
            return bool(OWN_INCREMENTAL.fullmatch(tail[1]))
        if tail[0] == "deps":
            return bool(OWN_FILE.fullmatch(tail[1]))
    return (len(tail) == 1 and path.name in {
        "mskdsp-upper.exe", "mskdsp-upper.pdb", "mskdsp-upper.d",
        "libmskdsp_upper_lib.rlib", "mskdsp_upper_lib.d", "mskdsp_upper_lib.pdb",
    })


def _record_path(target, path, result):
    path, relative = _inside(target, path)
    if not _owned(target, path):
        raise ValueError("拒绝记录不属于上位机的缓存产物")
    if path.exists():
        result.add(relative)


def _record_build_unit(target, directory, result):
    _record_path(target, directory, result)
    fingerprint = directory.parent.parent / ".fingerprint" / directory.name
    if fingerprint.is_dir():
        _record_path(target, fingerprint, result)


def prepare(target_dir, stage, version, manifest_path=None):
    if stage not in ("verify", "package"):
        raise ValueError("不支持的缓存阶段")
    generation = _generation(stage + "-" + version)
    target = _checked(target_dir)
    if target == target.parent:
        raise ValueError("Cargo 缓存不能使用磁盘根目录")
    root = _checked(target / ".upper-cache")
    wrapper = _checked(root / "bin" / "cargo_workspace_wrapper.cmd")
    current = os.environ.get("RUSTC_WORKSPACE_WRAPPER")
    if current and _checked(Path(current).absolute()) != wrapper:
        raise ValueError("已存在其他 Rust workspace wrapper，拒绝覆盖")
    manifest = _checked(manifest_path or Path(__file__).resolve().parents[2] / "src-tauri" / "Cargo.toml")
    if not manifest.is_file() or not re.search(
        r'(?m)^name\s*=\s*"mskdsp-upper"\s*$', manifest.read_text(encoding="utf-8")
    ):
        raise ValueError("Cargo 清单不属于上位机项目")
    target.mkdir(parents=True, exist_ok=True)
    identity = {"schema": SCHEMA, "project": PROJECT, "target_dir": str(target)}
    if (root / "identity.json").exists():
        _, _, state = _load(target)
        if state.get("project_id", PROJECT) != os.environ.get("CI_PROJECT_ID", PROJECT):
            raise ValueError("共享缓存的 GitLab 项目身份发生变化")
        # 同一项目可能分配到不同 Runner slot；归属使用项目身份，不固化 slot。
        state["manifest_path"] = str(manifest)
    else:
        if root.exists() and any(root.iterdir()):
            raise ValueError("缓存目录已有未知内容，拒绝接管")
        root.mkdir(parents=True, exist_ok=True)
        _json(root / "identity.json", identity)
        state = {"schema": SCHEMA, "target_dir": str(target), "manifest_path": str(manifest),
                 "project_id": os.environ.get("CI_PROJECT_ID", PROJECT),
                 "runs": {}, "generations": {}, "successes": []}
    wrapper.parent.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve()
    for filename in ("cargo_cache.py", "cargo_workspace_wrapper.cmd"):
        destination = _checked(wrapper.parent / filename)
        origin = source.with_name(filename)
        if origin != destination:
            temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
            temporary.write_bytes(origin.read_bytes())
            os.replace(temporary, destination)
    _checked(root / "generations" / generation).mkdir(parents=True, exist_ok=True)
    run = _run_id()
    state["current_run"] = run
    entry = state["runs"].setdefault(run, {"status": "running", "stages": {}})
    entry["stages"][stage] = {"generation": generation, "artifacts": [], "complete": False}
    state["generations"].setdefault(generation, {"stage": stage, "version": version,
                                                "artifacts": [], "managed": False})
    _json(root / "state.json", state)
    return {"root": str(root), "generation": generation, "wrapper": str(wrapper),
            "manifest_path": str(manifest)}


def wrapper(arguments):
    """透明转发 rustc；只将主 workspace 的增量根改到已登记代次。"""
    if not arguments:
        raise ValueError("缺少 rustc 命令")
    command = list(arguments)
    if "--crate-name" not in command:
        return subprocess.call(command)
    crate = command[command.index("--crate-name") + 1]
    if os.environ.get("CARGO_PKG_NAME") != PROJECT or crate not in OWN_CRATES:
        return subprocess.call(command)
    root = _checked(os.environ["UPPER_CARGO_CACHE_ROOT"])
    target, _, state = _load(root.parent)
    manifest = _checked(os.environ["UPPER_CARGO_MANIFEST_PATH"])
    if manifest != _checked(state["manifest_path"]) or _checked(
        Path(os.environ["CARGO_MANIFEST_DIR"]) / "Cargo.toml"
    ) != manifest:
        raise ValueError("Rust 编译源码与已登记的项目不一致")
    generation = _generation(os.environ["UPPER_CARGO_GENERATION"])
    if generation not in state["generations"]:
        raise ValueError("未登记的增量编译代次")
    incremental = _checked(root / "generations" / generation)
    extra = ""
    managed = False
    for index, arg in enumerate(command):
        if arg.startswith("incremental=") and index and command[index - 1] == "-C":
            command[index] = "incremental=" + str(incremental)
            managed = True
        elif arg.startswith("-Cincremental="):
            command[index] = "-Cincremental=" + str(incremental)
            managed = True
        if arg.startswith("extra-filename="):
            extra = arg.split("=", 1)[1]
        elif arg.startswith("-Cextra-filename="):
            extra = arg.split("=", 1)[1]
    code = subprocess.call(command)
    if code:
        return code
    paths = set()
    if "--out-dir" in command:
        output = _checked(Path(command[command.index("--out-dir") + 1]).absolute())
        _inside(target, output)
        if output.parent.name == "build" and OWN_HASH.fullmatch(output.name):
            _record_build_unit(target, output, paths)
        elif re.fullmatch(r"-[a-f0-9]{16}", extra):
            stems = {crate + extra, "lib" + crate + extra}
            for candidate in output.iterdir():
                if any(candidate.name.startswith(stem + ".") for stem in stems):
                    _record_path(target, candidate, paths)
            fingerprint = output.parent / ".fingerprint" / (PROJECT + extra)
            if fingerprint.is_dir():
                _record_path(target, fingerprint, paths)
    folder = _checked(root / "invocations" / _run_folder(_run_id()) / generation)
    folder.mkdir(parents=True, exist_ok=True)
    _json(folder / (uuid.uuid4().hex + ".json"), {"generation": generation,
                                               "managed": managed, "artifacts": sorted(paths)})
    return code


def record(target_dir, generation, logs):
    generation = _generation(generation)
    target, root, state = _load(target_dir)
    run = _run_id()
    entry = state["runs"].get(run)
    if not entry or generation not in {stage["generation"] for stage in entry["stages"].values()}:
        raise ValueError("构建未登记该缓存代次")
    manifest = _checked(state["manifest_path"])
    messages = []
    for log in logs:
        with Path(log).open(encoding="utf-8-sig", errors="replace") as stream:
            for line in stream:
                if line.startswith("[rust] "):
                    line = line[len("[rust] "):]
                if not line.startswith("{"):
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    messages.append(value)
    package_ids = set()
    own = []
    for message in messages:
        if message.get("reason") != "compiler-artifact" or not message.get("manifest_path"):
            continue
        if _checked(message["manifest_path"]) != manifest:
            continue
        name = message.get("target", {}).get("name", "").replace("-", "_")
        if name not in OWN_CRATES:
            raise ValueError("主项目报告了未受管的 Cargo target")
        package_ids.add(message["package_id"])
        own.append(message)
    paths = set()
    invocation_dir = _checked(root / "invocations" / _run_folder(run) / generation)
    if invocation_dir.is_dir():
        for item in invocation_dir.glob("*.json"):
            value = _read(item)
            if value.get("generation") != generation:
                raise ValueError("编译记录代次不一致")
            if value.get("managed"):
                state["generations"][generation]["managed"] = True
            for relative in value.get("artifacts", []):
                _record_path(target, target / relative, paths)
    # 同一基础版本的测试会跨流水线命中；保留该代次所有已知编译身份。
    for relative in state["generations"][generation]["artifacts"]:
        _record_path(target, target / relative, paths)
    for message in own:
        for filename in set(message.get("filenames", []) + ([message["executable"]] if message.get("executable") else [])):
            path = _checked(filename)
            if _owned(target, path):
                _record_path(target, path, paths)
            if path.parent.parent.name == "build" and OWN_HASH.fullmatch(path.parent.name):
                _record_build_unit(target, path.parent, paths)
            match = re.search(r"-([a-f0-9]{16})(?:\.|$)", path.name)
            if match:
                profile = path.parent.parent if path.parent.name == "deps" else path.parent
                fingerprint = profile / ".fingerprint" / (PROJECT + "-" + match.group(1))
                if fingerprint.is_dir():
                    _record_path(target, fingerprint, paths)
    for message in messages:
        if message.get("reason") == "build-script-executed" and message.get("package_id") in package_ids:
            directory = _checked(message["out_dir"]).parent
            _record_build_unit(target, directory, paths)
    _record_path(target, root / "generations" / generation, paths)
    complete = bool(own) and any(message.get("reason") == "build-finished" and message.get("success") is True
                                 for message in messages)
    state["generations"][generation]["artifacts"] = sorted(paths)
    for stage in entry["stages"].values():
        if stage["generation"] == generation:
            stage.update(artifacts=sorted(paths), complete=complete)
    _json(root / "state.json", state)
    return {"generation": generation, "artifacts": sorted(paths), "complete": complete}


def _legacy(target):
    """只列举有明确主项目名称的历史单元，绝不接管第三方依赖。"""
    result = set()
    for profile in (target / "release", target / "x86_64-pc-windows-msvc" / "release"):
        for folder in ("incremental", ".fingerprint", "build", "deps"):
            parent = _checked(profile / folder)
            if parent.is_dir():
                for path in parent.iterdir():
                    expression = (OWN_FILE if folder == "deps" else OWN_INCREMENTAL if folder == "incremental"
                                  else OWN_HASH)
                    if not expression.fullmatch(path.name):
                        continue
                    if _owned(target, path):
                        _, relative = _inside(target, path)
                        result.add(relative)
    return result


def _delete(path):
    path = _checked(path)
    if path.is_dir():
        for directory, children, files in os.walk(path, followlinks=False):
            for name in children + files:
                _checked(Path(directory) / name)
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def finish(target_dir, generation=None, status="failed", dry_run=False):
    if generation is not None:
        generation = _generation(generation)
    if status not in ("success", "failed"):
        raise ValueError("构建结束状态不合法")
    target = _checked(target_dir)
    root = _checked(target / ".upper-cache")
    if not (root / "identity.json").exists() or not (root / "state.json").exists():
        return {"run": _run_id(), "status": "unregistered", "protected_runs": [],
                "planned": [], "deleted": [], "retained_unknown": 0}
    target, root, loaded = _load(target_dir)
    state = deepcopy(loaded)
    run = _run_id()
    entry = state["runs"].get(run)
    if not entry:
        return {"run": run, "status": "unregistered", "protected_runs": state["successes"][-2:],
                "planned": [], "deleted": [], "retained_unknown": 0}
    if generation is not None and generation not in {stage["generation"] for stage in entry["stages"].values()}:
        raise ValueError("当前构建未登记指定缓存代次")
    entry["status"] = status
    if status == "success":
        if (set(entry["stages"]) != {"verify", "package"}
                or not all(stage["complete"] for stage in entry["stages"].values())):
            raise ValueError("成功构建必须完整记录测试与打包阶段的 Cargo 产物")
        state["successes"] = [value for value in state["successes"] if value != run] + [run]
    protected_runs = list(dict.fromkeys([run] + state["successes"][-2:]))
    keep = set()
    keep_generations = set()
    for key in protected_runs:
        for stage in state["runs"][key]["stages"].values():
            keep_generations.add(stage["generation"])
    for name in keep_generations:
        keep.update(state["generations"][name]["artifacts"])
        keep.add(".upper-cache/generations/" + name)
    candidates = set()
    complete = lambda key: (set(state["runs"][key]["stages"]) == {"verify", "package"}
                            and all(stage["complete"] for stage in state["runs"][key]["stages"].values()))
    known_successes = [key for key in state["successes"] if complete(key)]
    legacy = _legacy(target)
    if status == "success":
        for name, value in state["generations"].items():
            if name not in keep_generations:
                candidates.add(".upper-cache/generations/" + name)
                if complete(run):
                    candidates.update(value["artifacts"])
        # 历史 incremental 的散列与 Cargo artifact 散列不能互推。
        # 两次新 wrapper 完整成功后，主项目已统一使用受管根；精确产物记录
        # 同时保护这两次构建的 deps、fingerprint 和 build，才能回收旧单元。
        managed_keep = all(state["generations"][name].get("managed") for name in keep_generations)
        if len(known_successes) >= 2 and complete(run) and managed_keep:
            candidates.update(legacy)
    planned = []
    for relative in sorted(candidates - keep):
        path, checked_relative = _inside(target, target / relative)
        if not _owned(target, path):
            raise ValueError("回收清单包含不属于上位机的产物")
        if path.exists() and not any(relative.startswith(parent + "/") for parent in planned):
            planned.append(checked_relative)
    deleted = []
    if not dry_run:
        for relative in planned:
            _delete(target / relative)
            deleted.append(relative)
        _json(root / "state.json", state)
    return {"run": run, "status": status, "protected_runs": protected_runs,
            "planned": planned, "deleted": deleted,
            "retained_unknown": len(legacy - set(planned) - keep)}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "wrapper":
        return wrapper(sys.argv[2:])
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    ready = commands.add_parser("prepare")
    ready.add_argument("--stage", choices=("verify", "package"), required=True)
    ready.add_argument("--version", required=True)
    ready.add_argument("--manifest-path")
    for command in (ready, commands.add_parser("record"), commands.add_parser("finish")):
        command.add_argument("--target-dir", required=True)
    capture = commands.choices["record"]
    capture.add_argument("--generation", required=True)
    capture.add_argument("--log", action="append", required=True)
    done = commands.choices["finish"]
    done.add_argument("--generation")
    done.add_argument("--status", choices=("success", "failed"), required=True)
    done.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.target_dir, args.stage, args.version, args.manifest_path)
    elif args.command == "record":
        result = record(args.target_dir, args.generation, args.log)
    else:
        result = finish(args.target_dir, args.generation, args.status, args.dry_run)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, OSError, ValueError) as error:
        print("上位机编译缓存操作失败：" + str(error), file=sys.stderr)
        raise SystemExit(1)
