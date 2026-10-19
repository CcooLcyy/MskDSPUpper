"""使用作业临时认证检出设备协议固定子模块，不更改发布分支配置。"""
import os
import subprocess
import sys
from init_platform_proto import auth_environment


def initialize():
    server, environment = auth_environment(os.environ)
    command = ["git", "-c", "submodule.proto.url=" + server + "/mskdsp/mskdspproto.git",
               "submodule", "update", "--init", "proto"]
    result = subprocess.run(command, env=environment, capture_output=True, timeout=180, check=False)
    if result.returncode:
        raise ValueError("设备协议初始化失败，请检查固定提交和作业令牌跨项目访问权限")
    print("设备协议已按源码固定提交准备完成")


if __name__ == "__main__":
    try:
        initialize()
    except Exception:
        print("设备协议初始化失败，底层认证输出已隐藏", file=sys.stderr)
        raise SystemExit(1)
