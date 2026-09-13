# Gitee 更新包中转（已弃用）

更新包发布已迁移到 Cloudflare R2，当前工作流不再使用 Gitee 或服务器 SSH 中转。此文档保留作历史记录；请参阅 [R2 更新发布设计](R2更新发布设计.md)。

旧方案：GitHub Actions 将更新目录作为 Gitee Release 附件上传，上传完成后通过 SSH 连接触发服务器同步。服务器主动从公开 Gitee Release 下载、校验 SHA256，并原子替换 nginx 静态目录。
