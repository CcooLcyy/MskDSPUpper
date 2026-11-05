"""GitLab CI/Beta/Stable 的来源和真实安装包版本约束，不读取或输出凭据。"""
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
    tag = re.fullmatch(rf"v({VERSION})", branch or "")
    if tag:
        if base_version is not None and tag[1] != base_version:
            raise ValueError("正式标签必须与基础版本完全一致")
        return "stable"
    match = re.fullmatch(BETA, branch or "")
    if not match or (base_version is not None and match[1] not in
                     (base_version, ".".join(base_version.split(".")[:2]))):
        raise ValueError("仅允许 main、匹配的 Beta 分支或正式版本标签")
    return "beta"


def validate_pipeline(environment, channel):
    tag = environment.get("CI_COMMIT_TAG", "")
    branch = environment.get("CI_COMMIT_BRANCH", "")
    if (environment.get("CI_PIPELINE_SOURCE") not in ("push", "web")
            or (channel == "stable" and (not tag or branch))
            or (channel != "stable" and (tag or not branch))
            or channel in ("beta", "stable") and environment.get("CI_COMMIT_REF_PROTECTED") != "true"
            or environment.get("UPPER_RELEASE_CHANNEL", channel) != channel):
        raise ValueError("仅允许当前 push/web 流水线，Beta/Stable 必须使用受保护引用且渠道一致")


def validate_version(branch, channel, version, sha):
    if not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{40}", str(sha)):
        raise ValueError("安装包版本或源码提交不合法")
    if channel == "stable":
        if not re.fullmatch(VERSION, version) or resolve_source(branch, version) != "stable":
            raise ValueError("正式安装包必须使用与标签一致的纯版本")
        return
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
    branch = environment.get("CI_COMMIT_TAG") or environment.get("CI_COMMIT_BRANCH", "")
    base = json.loads((Path(root) / "package.json").read_text(encoding="utf-8"))["version"]
    channel = resolve_source(branch, base)
    validate_pipeline(environment, channel)
    return dict(channel=channel, ref=branch, tag=branch if channel == "stable" else "", metadata=f"package/metadata/{channel}.json",
                config=f"package/generated/tauri.{channel}.conf.json")


if __name__ == "__main__":
    try:
        print(json.dumps(release_context(Path.cwd())))
    except (ValueError, KeyError, OSError):
        raise SystemExit("无法确定 GitLab 发布渠道，请检查基础版本、分支及受保护流水线来源") from None
