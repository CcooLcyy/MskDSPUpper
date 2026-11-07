# 上位机发布约定

GitHub Actions 负责验证、签名打包和发布，MskDSPPlatform 提供 CI、Stable 和客户端 gRPC 更新。

| 来源 | 验证及交付 |
| --- | --- |
| PR | 前端类型检查及构建、lint、workflow/offline 测试、Python 发布脚本回归、完整 Rust 测试 |
| `main` | 完整验证、NSIS 签名打包、发布平台 `ci` |
| 受保护的 `release/X.Y` | 完整验证、NSIS 签名打包、保留 Actions 产物 |
| 受保护的 `vX.Y.Z` | 对该标签提交完整验证并签名打包，发布平台 `stable` |

## 来源与冻结

- `release/X.Y` 必须与源码基础版本的主、次版本匹配；不接受 `release/X.Y.Z` 或前导零。
- 正式标签必须与源码基础版本完全一致。保留 Tauri 签名、安装包 SHA256、流水线编号、项目、来源引用和完整 SHA 的冻结校验。
- 上传前及每次发布前读取远端标签，轻量标签提交或 annotated 标签解引用提交必须等于冻结 SHA。
- 冻结 SHA 必须位于远端 `main` 或匹配版本的 `release/X.Y` 历史。分支可以已经向前推进，无须 HEAD 等于标签。使用临时完整 Git 仓库抓取所观察的远端分支并做祖先校验，抓取身份变化则停止。
- 同一 Actions 运行的验证、打包与发布使用 `needs` 顺序门禁。发布任务按通道排队，执行中不因新提交取消。CI 上传前及发布前核对远端 `main`，过时构建只保留产物。

## 退役与操作边界

Beta 发布、GitLab 流水线和 R2 更新源工作流已退役。GitLab 配置保留在历史回归夹具中，已有包、标签和分支保留原状。配置和手动运行方式见 [GitHub Actions 与发版策略](doc/GitHub-Actions与发版策略.md)。

发布前在 GitHub 配置分支与标签保护、签名及发布环境。构建验证由对应提交的 CI 执行。

## 验收

覆盖 main 发布 CI、release 只保留产物、Beta 来源被拒绝、版本线不符及未保护引用被拒绝、正式标签与冻结 SHA 相等、远端 main/release 历史包含旧提交、错误版本线和无祖先关系被拒绝、签名摘要不匹配拒绝及 Stable 回执丢失后同通道确认。尚未运行的 CI 不视为验证通过。
