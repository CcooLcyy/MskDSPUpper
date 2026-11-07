"""校验发布流水线身份和安装包版本，不读取或输出凭据。"""
from datetime import datetime
import json
import os
from pathlib import Path
import re

NUMBER = r"(?:0|[1-9][0-9]*)"
VERSION = rf"{NUMBER}\.{NUMBER}\.{NUMBER}"
RELEASE = rf"release/({NUMBER}\.{NUMBER})"


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
    match = re.fullmatch(RELEASE, branch or "")
    if not match or (base_version is not None and match[1] not in
                     (".".join(base_version.split(".")[:2]),)):
        raise ValueError("仅允许 main、匹配的 release/X.Y 分支或正式版本标签")
    return "ci"


def release_identity(environment):
    if environment.get("GITHUB_ACTIONS") == "true":
        ref_type = environment.get("GITHUB_REF_TYPE")
        prefix = {"branch": "refs/heads/", "tag": "refs/tags/"}.get(ref_type)
        ref = environment.get("GITHUB_REF", "")
        if (not prefix or not ref.startswith(prefix)
                or environment.get("GITHUB_EVENT_NAME") not in ("push", "workflow_dispatch")):
            raise ValueError("GitHub 发布仅接受分支或标签的 push 或手动触发")
        ref = ref[len(prefix):]
        tag, branch = (ref, "") if ref_type == "tag" else ("", ref)
        protected = environment.get("GITHUB_REF_PROTECTED") == "true"
        sha = environment.get("GITHUB_SHA", "")
        pipeline_id = environment.get("GITHUB_RUN_ID", "")
        server = environment.get("GITHUB_SERVER_URL", "")
        repository_name = environment.get("GITHUB_REPOSITORY", "")
        if (server != "https://github.com" or not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", repository_name)
                or repository_name.split("/")[1] in (".", "..")):
            raise ValueError("GitHub 发布仓库地址不合法")
        repository = f"{server}/{repository_name}"
    else:
        if environment.get("CI_PIPELINE_SOURCE") not in ("push", "web"):
            raise ValueError("GitLab 发布仅接受 push 或手动流水线")
        tag = environment.get("CI_COMMIT_TAG", "")
        branch = environment.get("CI_COMMIT_BRANCH", "")
        ref = tag or branch
        protected = environment.get("CI_COMMIT_REF_PROTECTED") == "true"
        sha = environment.get("CI_COMMIT_SHA", "")
        pipeline_id = environment.get("CI_PIPELINE_ID", "")
        repository = environment.get("CI_PROJECT_URL", "")
    channel = resolve_source(ref)
    if (channel == "stable" and (not tag or branch)
            or channel != "stable" and (tag or not branch)
            or (channel == "stable" or branch.startswith("release/")) and not protected
            or environment.get("UPPER_RELEASE_CHANNEL", channel) != channel):
        raise ValueError("Release/Stable 必须使用受保护引用，且引用类型与渠道一致")
    return dict(channel=channel, ref=ref, tag=tag, sha=sha, pipeline_id=pipeline_id, repository=repository)


def validate_version(branch, channel, version, sha):
    if not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{40}", str(sha)):
        raise ValueError("安装包版本或源码提交不合法")
    if channel == "stable":
        if not re.fullmatch(VERSION, version) or resolve_source(branch, version) != "stable":
            raise ValueError("正式安装包必须使用与标签一致的纯版本")
        return
    match = re.fullmatch(rf"({VERSION})-(ci)\.([0-9]{{8}}t[0-9]{{6}})\+sha\.([a-f0-9]{{7}})", version)
    if not match or match[4] != sha[:7] or resolve_source(branch, match[1]) != channel:
        raise ValueError("安装包版本与源码分支、渠道或提交不匹配")
    expected = "ci"
    if match[2] != expected:
        raise ValueError("禁止更改候选安装包的 CI 版本身份")
    try:
        datetime.strptime(match[3], "%Y%m%dt%H%M%S")
    except ValueError:
        raise ValueError("安装包构建时间不合法") from None


def release_context(root, environment=None):
    environment = os.environ if environment is None else environment
    identity = release_identity(environment)
    base = json.loads((Path(root) / "package.json").read_text(encoding="utf-8"))["version"]
    channel = resolve_source(identity["ref"], base)
    return dict(channel=channel, ref=identity["ref"], tag=identity["tag"], metadata=f"package/metadata/{channel}.json",
                config=f"package/generated/tauri.{channel}.conf.json")


if __name__ == "__main__":
    try:
        print(json.dumps(release_context(Path.cwd())))
    except (ValueError, KeyError, OSError):
        raise SystemExit("无法确定发布渠道，请检查基础版本、分支及受保护流水线来源") from None
