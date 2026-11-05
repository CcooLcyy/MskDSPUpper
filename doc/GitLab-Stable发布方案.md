# GitLab Stable 发布

## 目标与边界

上位机使用当前确认的 Beta 源码生成正式 `0.8.0` 安装包：受保护 Git 标签 `v0.8.0` 指向已完成 Beta 验证的同一提交，标签 push/web 流水线执行完整校验、NSIS 签名打包、平台入库和 `stable` 发布。重新生成纯 `0.8.0` 版本，不能把 Beta 包修改平台通道引用充当 Stable。

只补 GitLab 发布能力及对应回归，不修改业务代码、旧 GitHub/R2 流程或客户端安装行为。`main` 保持 CI，受保护 Beta 分支保持 Beta。复用既有 `environment: ci` 下的签名和发布凭据；Stable 使用独立资源锁。

正式安装包名称使用去空格后的 Tauri 品牌和纯版本，例如 `MskDSPUpper-0.8.0.exe`；不再附加 stable、时间、SHA 或 windows-x64。CI/Beta 名称保留完整来源标识；正式包的提交、构建时间、目标架构等仍保留在元数据中。

## 来源与发布检查

- 仅允许无前导零的 `vX.Y.Z` 正式标签，必须与源码 `package.json` 基础版本完全相同，且 GitLab 标记为受保护引用；拒绝 MR、普通分支冒充正式来源及 CI/Beta 预发布版本。
- 复用现有 Stable 元数据生成器，显式传入 `--tag`；冻结身份必须为 `channel=stable`、`source_ref=vX.Y.Z`、`version=X.Y.Z`，保留实际提交、签名、大小和摘要。
- 上传前及每次发布前，查询远端正式标签及其 annotated peeled 引用，同时查询 `beta/X.Y.Z` 分支 HEAD。轻量标签的提交或 annotated 标签的 peeled 提交必须等于当前 `CI_COMMIT_SHA`，匹配 Beta 分支 HEAD 也必须是同一 SHA；任一缺失、移动或不匹配都拒绝发布。
- 操作方先将发布脚本支持提交同步到 Beta，并确认该提交完整 Beta CI 成功，再创建指向该提交的正式标签。脚本核对来源身份；对应 Beta CI 成功的证据由发布操作方跟踪确认，不用旧 Beta 结果替代。
- 现有签名、断点续传、禁止过期发布、回执丢失核对、公共目录、Stable 清单及实际下载包摘要检查全部保留。发布不执行安装。

## 验收

先补回归再实现：纯正式版本与标签/基础版本相符；未保护、错误版本、Beta/CI 冒充及错误流水线来源被拒绝；轻量和 annotated 标签正常，缺失 Beta、Beta 不同 SHA、正式标签移动/旧提交被拒绝；隔离 PowerShell 子进程确实向生成器传 `--channel stable --tag v0.8.0`；正式冻结身份正确；发布回执丢失只查询 Stable 通道。保留 main/Beta 原有回归。

本地不执行测试、构建或语法检查。先由同一提交的 Beta 完整 CI 验证发布支持，再创建正式标签，跟踪标签对应完整 CI 至发布及清单/安装包校验完成。
