# Gitee 更新包中转

GitHub Actions 将更新目录作为 Gitee Release 附件上传。上传完成后通过现有 SSH 连接触发服务器同步；服务器主动从公开 Gitee Release 下载、校验 SHA256，并原子替换现有 nginx 静态目录。客户端继续使用原更新地址。

Actions Secrets 必须包含 `GITEE_TOKEN`；`GITEE_OWNER`、`GITEE_REPO` 可在 Variables 中覆盖，默认是 `CcooLcyy/mskdsp-update`。Token 不得写入日志或仓库。

服务器同步脚本路径为 `/home/daniel/update-server/relay/sync_gitee_release.py`，状态和锁文件存放在 `/home/daniel/update-server/.gitee-relay-state`。下载失败或校验失败时保留旧版本。
