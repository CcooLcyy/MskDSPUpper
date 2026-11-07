"""在作业专属缓存中准备固定 Node，保留原测试运行方式和失败退出码。"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

VERSION = "v24.22.2"
DIRECTORY = f"node-{VERSION}-win-x64"
URL = f"https://nodejs.org/dist/{VERSION}/{DIRECTORY}.zip"
SHA256 = "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2"
ARCHIVE_CACHE = ".mskdsp-runtime.zip"
REQUIRED_FILES = ("node.exe", "npm.cmd", "npx.cmd", "node_modules/npm/bin/npm-cli.js", "node_modules/npm/package.json")


def hash_stream(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def file_hash(path):
    with path.open("rb") as stream:
        return hash_stream(stream)


def reject_links(path):
    for candidate in (path, *path.parents):
        if candidate.is_symlink() or (candidate.exists() and getattr(candidate.lstat(), "st_file_attributes", 0)
                                     & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            raise RuntimeError("Node 缓存路径不能包含符号链接或重解析点")


def archive_members(archive):
    members = []
    seen = set()
    for member in archive.infolist():
        # Windows 的 ZipInfo 会规范化反斜杠；安全校验必须查看原始名称。
        if "\\" in member.orig_filename:
            raise RuntimeError("Node 安装包包含不安全路径")
        name = member.filename.rstrip("/")
        parts = name.split("/")
        mode = member.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise RuntimeError("Node 安装包不允许包含链接")
        if (not name or member.filename.startswith("/") or "\\" in name
                or any(part in ("", ".", "..") or ":" in part for part in parts)
                or parts[0] != DIRECTORY or name.casefold() in seen
                or (len(parts) == 1 and not member.is_dir())):
            raise RuntimeError("Node 安装包包含不安全或重复路径")
        seen.add(name.casefold())
        if not member.is_dir():
            members.append((member, Path(*PurePosixPath(name).parts[1:])))
    names = {relative.as_posix() for _, relative in members}
    if not set(REQUIRED_FILES).issubset(names):
        raise RuntimeError("Node 安装包核心文件不完整")
    return members


def download(destination):
    try:
        with urllib.request.urlopen(URL, timeout=120) as response, destination.open("wb") as output:
            shutil.copyfileobj(response, output)
    except Exception:
        raise RuntimeError("下载固定 Node 安装包失败，请检查官网网络连接") from None


def runtime_version(directory):
    try:
        result = subprocess.run([str(directory / "node.exe"), "--version"], capture_output=True,
                                text=True, encoding="utf-8", timeout=30, check=False)
    except Exception:
        raise RuntimeError("执行 Node 版本检查失败") from None
    if result.returncode:
        raise RuntimeError("执行 Node 版本检查失败")
    return result.stdout.strip()


def validate(directory):
    """从固定校验和归档推导文件身份，不能信任可自行改写的成功标记。"""
    archive_path = directory / ARCHIVE_CACHE
    reject_links(directory)
    if not archive_path.is_file() or file_hash(archive_path) != SHA256:
        raise RuntimeError("Node 缓存归档 SHA256 校验失败，拒绝复用")
    with zipfile.ZipFile(archive_path) as archive:
        members = archive_members(archive)
        expected = {relative.as_posix() for _, relative in members} | {ARCHIVE_CACHE}
        actual = set()
        for entry in directory.rglob("*"):
            reject_links(entry)
            if entry.is_file():
                actual.add(entry.relative_to(directory).as_posix())
        if expected != actual:
            raise RuntimeError("Node 缓存文件集合不完整或已发生变化，拒绝复用")
        for member, relative in members:
            target = directory / relative
            with archive.open(member) as original:
                if file_hash(target) != hash_stream(original):
                    raise RuntimeError("Node 缓存文件内容校验失败，拒绝复用")
    if runtime_version(directory) != VERSION:
        raise RuntimeError("Node 实际版本与固定版本不一致")


def ensure(cache_root):
    root = Path(cache_root).absolute()
    reject_links(root)
    root.mkdir(parents=True, exist_ok=True)
    # Windows Runner 的临时目录可能使用 8.3 短路径，统一返回规范路径。
    root = root.resolve(strict=True)
    target = root / DIRECTORY
    if target.exists() or target.is_symlink():
        validate(target)
        return {"directory": str(target), "version": VERSION, "source": "cache"}
    with tempfile.TemporaryDirectory(prefix=".node-install-", dir=root) as temporary:
        staging = Path(temporary)
        archive_path = staging / "download.zip"
        try:
            download(archive_path)
        except Exception:
            raise RuntimeError("下载固定 Node 安装包失败，请检查官网网络连接") from None
        if file_hash(archive_path) != SHA256:
            raise RuntimeError("Node 下载归档 SHA256 校验失败，拒绝安装")
        extracted = staging / DIRECTORY
        extracted.mkdir()
        with zipfile.ZipFile(archive_path) as archive:
            members = archive_members(archive)
            for member, relative in members:
                destination = extracted / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output)
        archive_path.rename(extracted / ARCHIVE_CACHE)
        validate(extracted)
        # 临时目录与目标同盘，只有完整校验后才发布可复用目录。
        extracted.rename(target)
    return {"directory": str(target), "version": VERSION, "source": "download"}


def main(arguments=None):
    parser = argparse.ArgumentParser(description="准备 CI 固定版本 Node 运行时")
    parser.add_argument("--cache-root", required=True)
    options = parser.parse_args(arguments)
    try:
        result = ensure(options.cache_root)
    except RuntimeError as error:
        print(f"Node 运行时准备失败：{error}", file=sys.stderr)
        return 1
    except Exception:
        print("Node 运行时准备失败，请检查缓存目录和安装包完整性", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
