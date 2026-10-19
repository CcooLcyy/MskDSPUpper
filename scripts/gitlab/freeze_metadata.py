"""从已有 staging 产物冻结上位机平台身份，不接受其他通道。"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
from platform_client import ClientError, sha256_file


def freeze(metadata_path, target_dir):
    metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
    sha = os.environ.get("CI_COMMIT_SHA", "")
    actual = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if (metadata["channel"] != "ci" or metadata["shortSha"] != sha[:7] or actual != sha
            or os.environ.get("CI_COMMIT_BRANCH") != "main"):
        raise ClientError("构建与冻结源码身份不一致")
    stage = Path("package/staging") / metadata["channelLabel"] / metadata["platform"]
    manifest = json.loads((stage / "staging-manifest.json").read_text(encoding="utf-8"))
    installers = manifest["installers"]
    if len(installers) != 1 or not installers[0].endswith(".exe"):
        raise ClientError("必须提供唯一 NSIS 安装包")
    source = stage / installers[0]
    if source.is_symlink() or not source.is_file():
        raise ClientError("安装包必须为普通文件")
    signature_file = Path(str(source) + ".sig")
    if signature_file.is_symlink() or not signature_file.is_file():
        raise ClientError("缺少真实 Tauri 更新签名，停止平台发布")
    signature = signature_file.read_text(encoding="utf-8").strip()
    if not signature:
        raise ClientError("Tauri 更新签名为空")
    target = Path(target_dir)
    target.mkdir(parents=True, exist_ok=True)
    archive = target / source.name
    shutil.copyfile(source, archive)
    shutil.copyfile(signature_file, target / signature_file.name)
    identity = dict(product="mskdsp-upper", version=metadata["effectiveVersion"], platform="windows-x86_64-nsis",
                    file_name=archive.name, size=archive.stat().st_size, sha256=sha256_file(archive),
                    signature=signature, notes=metadata["releaseTitle"], source_repository=os.environ["CI_PROJECT_URL"],
                    source_ref="main", source_sha=sha, channel="ci", pipeline_id=os.environ["CI_PIPELINE_ID"])
    (target / "upload-metadata.json").write_text(json.dumps(identity, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (target / "SHA256SUMS").write_text(identity["sha256"] + "  " + archive.name + "\n", encoding="utf-8")
    print("已冻结上位机 CI 平台产物：" + archive.name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", default="package/metadata/ci.json")
    parser.add_argument("--output", default="package/platform")
    args = parser.parse_args()
    freeze(args.metadata, args.output)
