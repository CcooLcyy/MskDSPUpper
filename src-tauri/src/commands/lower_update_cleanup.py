"""仅在当前镜像运行时清理上传目录中的 MskDSP 历史安装包。"""

import json
import errno
import os
import re
import secrets
import stat
import subprocess
import sys


PACKAGE_NAME = re.compile(
    r"mskdsp-v?[0-9]+(?:\.[0-9]+){1,2}"
    r"(?:[-.][A-Za-z0-9][A-Za-z0-9._-]*)?-linux-(?:arm64|x64)"
)
IMAGE_ID = re.compile(r"sha256:[0-9a-fA-F]{64}")
HEADER_LIMIT = 64 * 1024
CONTAINER_MARKER = re.compile(br'(?:^|\n)CONTAINER_NAME="mskdsp"\r?\n')
ARCHIVE_MARKER = re.compile(br"\n__ARCHIVE_BELOW__\r?\n")


def query_runtime():
    """在删除所在的进程内查询固定容器，查询失败时禁止删除。"""
    try:
        result = subprocess.run(
            ["docker", "inspect", "--type=container", "--format", "{{.State.Running}} {{.Image}}", "mskdsp"],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("查询下位机运行容器失败: " + str(error)) from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError("查询下位机运行容器失败: " + detail)
    fields = result.stdout.split()
    if len(fields) != 2 or fields[0] not in ("true", "false") or not IMAGE_ID.fullmatch(fields[1]):
        raise RuntimeError("查询下位机运行容器返回的状态或镜像 ID 不合法")
    return fields[0] == "true", fields[1].lower()


def _identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _open_directory_without_links(install_dir):
    """从根目录逐段打开路径，任意祖先和最终目录都不允许是符号链接。"""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory_fd = os.open("/", flags)
    try:
        for component in install_dir.split("/"):
            if component in ("", "."):
                continue
            next_fd = os.open(component, flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        return directory_fd
    except OSError as error:
        os.close(directory_fd)
        raise RuntimeError("打开安装包清理目录失败，路径不能经过符号链接: " + str(error)) from error


def _inspect_package(directory_fd, name):
    """通过目录描述符读取普通文件头，不跟随链接，也不阻塞在被替换的 FIFO 上。"""
    try:
        before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(before.st_mode):
        return None
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or _identity(before) != _identity(opened):
            raise RuntimeError("安装包在检查期间发生变化: " + name)
        header = os.read(descriptor, HEADER_LIMIT)
        marker = ARCHIVE_MARKER.search(header)
        if (
            not header.startswith(b"#!/usr/bin/env bash\n")
            or marker is None
            or not CONTAINER_MARKER.search(header[:marker.start() + 1])
            or opened.st_size <= marker.end()
        ):
            return None
        if _identity(opened) != _identity(os.fstat(descriptor)):
            raise RuntimeError("安装包在读取期间发生变化: " + name)
        return _identity(opened)
    finally:
        os.close(descriptor)


def _assert_current_unchanged(directory_fd, name, identity):
    try:
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError as error:
        raise RuntimeError("当前安装包在清理期间发生变化，已停止清理") from error
    if not stat.S_ISREG(current.st_mode) or _identity(current) != identity:
        raise RuntimeError("当前安装包在清理期间发生变化，已停止清理")


def _restore_quarantined_package(directory_fd, quarantine_fd, quarantine_name, name):
    """用不覆盖目标的原子硬链接恢复；不能恢复时保留隔离条目及恢复位置。"""
    recovery_path = quarantine_name + "/" + name
    try:
        info = os.stat(name, dir_fd=quarantine_fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            return "隔离对象是目录，已完整保留，可恢复位置（相对于安装目录）: " + recovery_path
        os.link(name, name, src_dir_fd=quarantine_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
        os.unlink(name, dir_fd=quarantine_fd)
        return "隔离对象已安全恢复到原名: " + name
    except OSError as error:
        return "隔离对象已保留，可恢复位置（相对于安装目录）: " + recovery_path + ": " + str(error)


def _delete_package(directory_fd, name, identity):
    """将条目移入私有隔离目录，再校验实际对象，避免删除同名竞态替换文件。"""
    package_fd = None
    quarantine_fd = None
    quarantine_name = None
    moved = False
    try:
        latest = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not stat.S_ISREG(latest.st_mode) or _identity(latest) != identity:
            raise RuntimeError("历史安装包在删除前发生变化，已停止清理: " + name)
        package_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
        if _identity(os.fstat(package_fd)) != identity:
            raise RuntimeError("历史安装包在打开时发生变化，已停止清理: " + name)
        while quarantine_name is None:
            candidate_name = ".mskdsp-package-cleanup-" + secrets.token_hex(16)
            try:
                os.mkdir(candidate_name, mode=0o700, dir_fd=directory_fd)
                quarantine_name = candidate_name
            except FileExistsError:
                continue
        quarantine_fd = os.open(
            quarantine_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd,
        )
        quarantine_info = os.fstat(quarantine_fd)
        if quarantine_info.st_uid != os.geteuid() or stat.S_IMODE(quarantine_info.st_mode) != 0o700:
            raise RuntimeError("安装包隔离目录所有者或权限不符合私有目录要求")
        os.rename(name, name, src_dir_fd=directory_fd, dst_dir_fd=quarantine_fd)
        moved = True
        quarantined = os.stat(name, dir_fd=quarantine_fd, follow_symlinks=False)
        # rename 会修改 ctime；保持原文件描述符可防止 inode 重用，并核对移动后的完整快照。
        if (
            not stat.S_ISREG(quarantined.st_mode)
            or _identity(quarantined)[:4] != identity[:4]
            or _identity(quarantined) != _identity(os.fstat(package_fd))
        ):
            raise RuntimeError("历史安装包在隔离移动时发生变化，已停止清理: " + name)
        os.unlink(name, dir_fd=quarantine_fd)
        moved = False
    except (OSError, RuntimeError) as error:
        detail = "删除历史安装包失败: " + name + ": " + str(error)
        if moved:
            detail += "; " + _restore_quarantined_package(directory_fd, quarantine_fd, quarantine_name, name)
        raise RuntimeError(detail) from error
    finally:
        if package_fd is not None:
            os.close(package_fd)
        if quarantine_fd is not None:
            os.close(quarantine_fd)
        if quarantine_name is not None:
            try:
                os.rmdir(quarantine_name, dir_fd=directory_fd)
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ENOTEMPTY, errno.EEXIST):
                    raise RuntimeError("清理空安装包隔离目录失败: " + quarantine_name + ": " + str(error)) from error


def cleanup_packages(install_dir, current_package, expected_image_id, runtime_query=None):
    """校验当前包和运行镜像后，仅删除有发布命名及自解压标识的历史包。"""
    if not PACKAGE_NAME.fullmatch(current_package):
        raise RuntimeError("当前安装包名称不符合 MskDSP 发布安装包格式")
    if not IMAGE_ID.fullmatch(expected_image_id):
        raise RuntimeError("清理请求缺少有效的期望镜像 ID")
    if not os.path.isabs(install_dir) or ".." in install_dir.split("/"):
        raise RuntimeError("清理目录必须是无路径穿越的绝对目录")
    normalized_directory = os.path.normpath(install_dir)
    if normalized_directory == "/":
        raise RuntimeError("禁止清理根目录中的安装包")
    directory_fd = _open_directory_without_links(normalized_directory)
    try:
        opened_directory = os.fstat(directory_fd)
        root = os.stat("/")
        if (opened_directory.st_dev, opened_directory.st_ino) == (root.st_dev, root.st_ino):
            raise RuntimeError("禁止清理根目录中的安装包")
        try:
            current_identity = _inspect_package(directory_fd, current_package)
        except (OSError, RuntimeError) as error:
            raise RuntimeError("检查当前安装包失败: " + str(error)) from error
        if current_identity is None:
            raise RuntimeError("当前安装包不存在、不是普通文件或缺少完整自解压安装包标识")
        with os.scandir(directory_fd) as entries:
            candidate_names = sorted(
                entry.name for entry in entries
                if entry.name != current_package and PACKAGE_NAME.fullmatch(entry.name)
            )
        running, image_id = (runtime_query or query_runtime)()
        if not running:
            raise RuntimeError("下位机容器未运行，禁止清理历史安装包")
        if not isinstance(image_id, str) or image_id.lower() != expected_image_id.lower():
            raise RuntimeError("下位机运行镜像与期望镜像不一致，禁止清理历史安装包")
        removed_files = 0
        reclaimed_bytes = 0
        _assert_current_unchanged(directory_fd, current_package, current_identity)
        for name in candidate_names:
            try:
                identity = _inspect_package(directory_fd, name)
            except OSError as error:
                raise RuntimeError("检查历史安装包失败: " + name + ": " + str(error)) from error
            if identity is None:
                continue
            _assert_current_unchanged(directory_fd, current_package, current_identity)
            _delete_package(directory_fd, name, identity)
            removed_files += 1
            reclaimed_bytes += identity[2]
        return {"removed_files": removed_files, "reclaimed_bytes": reclaimed_bytes}
    finally:
        os.close(directory_fd)


def main(arguments):
    if len(arguments) != 3:
        print("历史安装包清理失败: 需要安装目录、当前包名和期望镜像 ID", file=sys.stderr)
        return 1
    try:
        result = cleanup_packages(*arguments)
    except (OSError, RuntimeError) as error:
        print("历史安装包清理失败: " + str(error), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
