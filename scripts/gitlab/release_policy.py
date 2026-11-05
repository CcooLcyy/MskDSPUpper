"""GitLab CI/Beta 的来源和真实安装包版本约束，不读取或输出凭据。"""
from datetime import datetime
import json
import os
from pathlib import Path
import re

NUMBER = r"(?:0|[1-9][0-9]*)"
VERSION = rf"{NUMBER}\.{NUMBER}\.{NUMBER}"
BETA = rf"beta/({NUMBER}\.{NUMBER}(?:\.{NUMBER})?)"


def resolve_source(branch, base_version=None):
    if base_version is not None and not re.fullmatch(VERSION, base_version):
        raise ValueError("基础版本必须为合法的三段数字版本")
    if branch == "main":
        return "ci"
    match = re.fullmatch(BETA, branch or "")
    if not match or (base_version is not None and match[1] not in
                     (base_version, ".".join(base_version.split(".")[:2]))):
        raise ValueError("仅允许 main 或与基础版本匹配的 Beta 版本分支")
    return "beta"


def validate_pipeline(environment, channel):
    if (environment.get("CI_PIPELINE_SOURCE") not in ("push", "web")
            or environment.get("CI_COMMIT_TAG")
            or channel == "beta" and environment.get("CI_COMMIT_REF_PROTECTED") != "true"
            or environment.get("UPPER_RELEASE_CHANNEL", channel) != channel):
        raise ValueError("仅允许当前 push/web 流水线，Beta 必须使用受保护分支且渠道一致")


def validate_version(branch, channel, version, sha):
    if not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{40}", str(sha)):
        raise ValueError("安装包版本或源码提交不合法")
    match = re.fullmatch(rf"({VERSION})-(ci|beta(?:\.{NUMBER}){{2,3}})\.([0-9]{{8}}t[0-9]{{6}})\+sha\.([a-f0-9]{{7}})", version)
    if not match or match[4] != sha[:7] or resolve_source(branch, match[1]) != channel:
        raise ValueError("安装包版本与源码分支、渠道或提交不匹配")
    expected = "ci" if channel == "ci" else "beta." + branch.removeprefix("beta/")
    if match[2] != expected:
        raise ValueError("禁止将 CI 产物改通道冒充 Beta 安装包")
    try:
        datetime.strptime(match[3], "%Y%m%dt%H%M%S")
    except ValueError:
        raise ValueError("安装包构建时间不合法") from None


def release_context(root, environment=None):
    environment = os.environ if environment is None else environment
    branch = environment.get("CI_COMMIT_BRANCH", "")
    base = json.loads((Path(root) / "package.json").read_text(encoding="utf-8"))["version"]
    channel = resolve_source(branch, base)
    validate_pipeline(environment, channel)
    return dict(channel=channel, ref=branch, metadata=f"package/metadata/{channel}.json",
                config=f"package/generated/tauri.{channel}.conf.json")


if __name__ == "__main__":
    try:
        print(json.dumps(release_context(Path.cwd())))
    except (ValueError, KeyError, OSError):
        raise SystemExit("无法确定 GitLab 发布渠道，请检查基础版本、分支及受保护流水线来源") from None
