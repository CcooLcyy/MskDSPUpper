"""按源码中的仓库地址检出设备协议固定子模块。"""
import os
import subprocess
import sys


def initialize():
    environment = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    for arguments in (["sync", "--", "proto"], ["update", "--init", "--", "proto"]):
        command = ["git", "submodule", *arguments]
        result = subprocess.run(command, env=environment, capture_output=True, timeout=180, check=False)
        if result.returncode:
            raise ValueError("设备协议初始化失败，请检查源码仓库地址、固定提交和网络访问")
    print("设备协议已按源码固定提交准备完成")


if __name__ == "__main__":
    try:
        initialize()
    except Exception:
        print("设备协议初始化失败，底层认证输出已隐藏", file=sys.stderr)
        raise SystemExit(1)
