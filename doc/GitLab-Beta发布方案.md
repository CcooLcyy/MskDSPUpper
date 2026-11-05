# GitLab Beta 发布

## 目标与边界

`main` 保持现有 CI 渠道。推送 `beta/X.Y` 或 `beta/X.Y.Z` 后自动完成相同的前端、Rust 校验及 NSIS 签名打包，再上传平台并显式发布 `beta`。当前基础版本为 `0.8.0`，对应 `beta/0.8` 或 `beta/0.8.0`；不支持不匹配版本线、标签、合并请求或 Stable 发布。

Beta 必须重新构建真实 Beta 版本，复用既有元数据生成器，版本为 `0.8.0-beta.<版本线>.<UTC时间>+sha.<提交短号>`。不能把 CI 包改通道充当 Beta，也不使用平台 PromoteRelease、旧 GitHub workflow 或 R2 发布。

## 流程与保护

1. GitLab 规则根据分支选择 `ci` / `beta`，使用各自 resource group。两种渠道执行同一套 verify → package → publish，构建失败不得进入发布。两种渠道均沿用 `environment: ci` 获取现有变量；实际产物与发布渠道由来源分支确定，不由 environment 名称决定。
2. 打包前检查当前基础版本与 Beta 版本线匹配；Beta 要求受保护分支，签名私钥和上传凭据沿用现有 scope 为 `ci` 的受保护变量。不打印秘密，不把秘密写入产物。
3. 使用既有 Tauri 签名，生成渠道对应的元数据和配置；保持平台 gRPC 更新及禁用插件 HTTP 更新端点的现状。冻结产物必须核对实际 HEAD、分支、渠道和完整版本。
4. 上传端只接受当前 push/web 流水线、同一项目/分支/SHA/流水线编号的冻结身份。Beta 版本必须包含对应版本线和 SHA，禁止 CI/Beta 交叉发布。
5. 上传前及每次 PublishRelease 前通过带内存认证的 `git ls-remote` 核对源分支 HEAD；过期分支构建不得覆盖滚动通道。按当前渠道核对公共 gRPC 目录、兼容清单、签名和安装包实际 SHA256。

主分支提交发布脚本后，需把经确认的同一提交同步到 Beta 分支才能使用新规则。服务端先保护 Beta 分支并确认 protected 变量及 Runner 可用；分支创建本身不使旧提交拥有新配置。发布后的软件安装不在本方案范围。

## 验收

先补 CI 回归再实现：main 身份不变；匹配 Beta 分支生成真实 Beta 版本并发布 beta；CI 版本伪装 Beta、跨渠道、错误版本线、非 protected Beta、旧 SHA、标签/MR 被拒绝；源分支变动阻止发布；回执丢失只核对本渠道；公开清单及实际包摘要匹配。通过隔离工具进程检查 PowerShell 实际传给元数据生成器、打包和冻结脚本的参数。

本地不执行测试或构建；提交后跟踪 Beta 对应提交流水线直到完成，核对 Beta 清单及包源码身份。main 路径由同次发布脚本回归覆盖，不能用旧 main CI 的结果替代 Beta 验证。
