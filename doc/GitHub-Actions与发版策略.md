# GitHub Actions 兼容发布约定

现行产品发布以 GitLab 为准，完整规则见 [上位机发布约定](../RELEASING.md) 和 [GitLab Stable 发布方案](GitLab-Stable发布方案.md)。主干发布 CI，受保护的 `release/X.Y` 维护分支只保留产物，受保护的 `vX.Y.Z` 标签通过自身完整验证后发布 Stable。

GitHub 保留 `ci.yml`、`release.yml` 和 `sync-static-updater.yml` 兼容入口。正式 Release 必须使用已存在的版本标签，标签提交位于远端 `main` 或匹配版本的 `release/X.Y` 历史；不再依赖 Beta 分支。静态源回填只支持 Stable。

Beta workflow、分支解析、来源校验专用脚本及生成新 Beta 元数据的能力已删除。历史方案可通过 Git 历史查阅；现有 Beta 分支、标签、包及其元数据不因源码清理自动删除。历史包解析与客户端迁移测试继续保留。

兼容发布仍复用 `emit-build-metadata`、`apply-channel-version`、`render-tauri-config`、`stage-release`、`create-delivery-bundle` 和校验和脚本。构建元数据 schema 保留旧包格式读取能力，不代表允许重新发布已退役通道。

R2 资产按通道和平台组织，先上传并验证资产，再更新 `latest.json`。上传脚本拒绝 Beta；配置、凭据及现行参数见 [R2 更新发布设计](../docs/R2更新发布设计.md)。签名、固定来源 SHA、资产摘要和冻结校验继续生效。

所有构建、类型检查、静态检查及自动化测试由对应提交的 CI 执行；流水线完成前不视为验证通过。
