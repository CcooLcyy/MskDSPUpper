"""核对远端正式标签及 main 或匹配 release/X.Y 的完整历史来源。"""
import argparse
import base64
import os
import re
import subprocess
import tempfile


def verify_stable_source(repository, tag_name, sha, environment=None):
    match = re.fullmatch(r"v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\.(?:0|[1-9][0-9]*)", tag_name)
    if not match or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("正式发布来源身份不合法")
    environment = dict(os.environ if environment is None else environment)
    tag = "refs/tags/" + tag_name
    branches = ["refs/heads/main", "refs/heads/release/" + match[1]]
    refs = [tag, tag + "^{}", *branches]

    def run(arguments, *, cwd=None):
        return subprocess.run(["git", *arguments], env=environment, cwd=cwd,
                              capture_output=True, text=True, timeout=180, check=False)

    def remote_refs(selected):
        result = run(["ls-remote", "--exit-code", repository, *selected])
        observed = {}
        for line in result.stdout.splitlines():
            values = line.split("\t")
            if (len(values) != 2 or values[1] not in selected or values[1] in observed
                    or not re.fullmatch(r"[a-f0-9]{40}", values[0])):
                raise ValueError("远端引用响应不合法")
            observed[values[1]] = values[0]
        if result.returncode:
            raise ValueError("无法读取远端来源引用")
        return observed

    observed = remote_refs(refs)
    if tag not in observed or observed.get(tag + "^{}", observed[tag]) != sha:
        raise ValueError("正式标签缺失或已移动")
    available = [ref for ref in branches if ref in observed]
    if not available:
        raise ValueError("缺少 main 或匹配版本的 release 历史")
    # 使用独立完整仓库，避免浅克隆历史不足或本地引用过期。
    with tempfile.TemporaryDirectory(prefix="upper-stable-source-") as directory:
        if run(["init", "--bare", directory]).returncode:
            raise ValueError("无法初始化来源检查仓库")
        for index, ref in enumerate(available):
            destination = f"refs/source/{index}"
            if run(["fetch", "--no-tags", repository, f"+{ref}:{destination}"], cwd=directory).returncode:
                raise ValueError("无法获取完整来源历史")
            head = run(["rev-parse", destination], cwd=directory)
            if head.returncode or head.stdout.strip() != observed[ref]:
                raise ValueError("来源分支在校验期间发生变化")
            ancestry = run(["merge-base", "--is-ancestor", sha, destination], cwd=directory)
            if ancestry.returncode == 0:
                # 完整抓取可能耗时；返回前重新读取，防止标签在抓取期间被移动或替换。
                current_tag = remote_refs([tag, tag + "^{}"])
                frozen_tag = {ref: observed[ref] for ref in (tag, tag + "^{}") if ref in observed}
                if current_tag != frozen_tag:
                    raise ValueError("正式标签在来源历史校验期间发生变化")
                return
            if ancestry.returncode not in (1, 128):
                raise ValueError("无法核对来源提交的祖先关系")
    raise ValueError("正式提交不属于 main 或匹配版本的 release 历史")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    environment = dict(os.environ)
    repository = args.repository
    if repository == "origin":
        result = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True, check=True)
        repository = result.stdout.strip()
    if environment.get("GH_TOKEN"):
        encoded = base64.b64encode(("x-access-token:" + environment["GH_TOKEN"]).encode()).decode()
        environment.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0=f"http.{repository}/.extraHeader",
                           GIT_CONFIG_VALUE_0="Authorization: Basic " + encoded)
    try:
        verify_stable_source(repository, args.tag, args.sha, environment)
    except (ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit("正式远端标签或 main/release 历史校验失败") from None
    print("已核对正式远端标签及来源历史")


if __name__ == "__main__":
    main()
