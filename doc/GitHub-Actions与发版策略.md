# GitHub Actions 与发版策略

GitHub Actions 使用 `ci.yml` 验证和签名打包，再将冻结产物发布到 MskDSPPlatform。详细通道规则见 [上位机发布约定](../RELEASING.md)。

- 验证和签名打包在 GitHub 托管 Windows Runner 上执行。两个公开协议库均按源码记录的提交获取。
- 平台发布使用独立作业，下载同一次运行的冻结产物。上传及发布前检查远端来源，完成后核对公开目录、清单、下载包 SHA256 和签名。
- `release/X.Y` 只保留 Actions 产物。正式标签从已迁移工作流的 main 或匹配版本维护分支创建。手动重跑可使用 `gh workflow run ci.yml --ref <分支或标签>`。重跑历史正式标签会发布该版本，仅在需要回退时使用。
- 旧的 R2 发布和回填工作流已退役。上位机通过平台 gRPC 查询和下载更新。

## GitHub 仓库配置

1. 为 `main`、`release/*` 和正式 `v*` 标签配置规则集，限制受信任的写入者。维护分支与标签需要受保护引用。
2. 创建 `upper-signing` 环境，仅允许受信任的 main、维护分支及正式标签。配置与已安装客户端公钥匹配的 `TAURI_SIGNING_PRIVATE_KEY`，私钥有密码时配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
3. 创建 `upper-ci` 和 `upper-stable` 发布环境，分别限制为 main 和正式标签，配置 `PLATFORM_UPLOAD_TOKEN` 及下表变量。将部署限制和凭据配置一并完成。
4. 发布 Runner 需要访问 GitHub、平台 gRPC 和公开下载地址。默认使用 `ubuntu-latest`。若上传入口只在内网可达，将仓库变量 `UPPER_PUBLISH_RUNNER` 设为内网发布 Runner 的标签 JSON 数组，例如 `["self-hosted","linux","upper-publish"]`，该 Runner 需具备 PowerShell 7。

| 变量 | 用途 |
| --- | --- |
| `PLATFORM_GRPC_ENDPOINT` | 平台上传地址，格式为 `host:port` |
| `PLATFORM_PUBLIC_BASE_URL` | 发布后核对清单和安装包使用的平台 HTTP(S) 根地址 |
| `PLATFORM_GRPC_PLAINTEXT` | 使用明文入口时设为 `1`，默认 TLS |
| `PLATFORM_GRPC_PUBLIC_PLAINTEXT_ENDPOINT` | 公网明文例外，必须与上传地址的数字 IP 和端口完全一致 |
| `PLATFORM_GRPC_CA_FILE` | 使用私有 CA 时设置为发布 Runner 上的 CA 文件路径 |

首次切换应先验证 main 的 CI 通道及客户端更新，再发正式标签。验收以同一次 Actions 运行的签名安装包、平台记录和下载摘要为准。
