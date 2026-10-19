# 上位机 CI 包接入平台

本轮仅接入 `main` 的 CI 通道，保留 Beta/Stable 的 GitHub 工作流。GitLab Windows Runner 完成检查、固定提交构建和 NSIS 打包，经平台 gRPC 续传、校验入库，再显式发布 CI 通道；发布后必须读取公开目录、清单及下载安装包核对 SHA256，才判定成功。

沿用现有 `emit-build-metadata`、`apply-channel-version`、`render-tauri-config`、`stage-release`。协议按 `platform-proto.ref` 固定提交获取，设备协议子模块仅在 GitLab 作业内改为同实例地址，不改变 Beta/Stable 的子模块配置。Runner 可通过 `RUNNER_ENV_PATH` 注入工具环境，不把机器目录写入源码。

编译阶段必须导入 x64 MSVC 与 Windows SDK 环境。`VSDEVCMD` 可指定开发环境脚本；默认从 `RUNNER_ENV_ROOT/tools/vs2022/Common7/Tools/VsDevCmd.bat` 读取。脚本通过 `cmd /c call ... && set` 在内存中导入环境，不打印完整环境或认证材料。签名密码未配置时，Node 子进程显式传入空密码，避免 Windows PowerShell 删除空环境变量后触发交互。

CI 产物身份为 `mskdsp-upper`、`windows-x86_64-nsis`、完整源码 SHA、GitLab 仓库地址和现有 CI SemVer。上传前以及发布前核对远端 main；过时任务保留构建产物但不能改写通道。任务串行发布；认证材料仅从保护变量读取，不进入命令参数或产物。

平台现有上位机产品强制要求真实 Tauri 签名。使用现有验签公钥对应私钥，不生成替代公钥。缺少私钥时停止发布构建，不能用占位签名宣称成功。平台 HTTP 公共地址用于清单与安装包，gRPC 上传仅允许 TLS 或显式内网 IP。

客户端已经切换平台 gRPC 查询与下载安装包；生成的 CI 配置统一清空 updater HTTP 端点，使用本地适配的 Tauri updater 2.10.1 验签和手动安装，不依赖 HTTP `latest.json`，也不回退 GitHub/R2。平台 HTTP 公共地址仍用于发布后的旧客户端兼容清单及实际下载安装包验收。`stage-release` 不传 GitHub 仓库或静态下载地址，因此跳过本地 `latest.json`，由平台生成兼容下载清单；冻结脚本从 staging 清单取唯一 NSIS 和对应签名。

`.gitlab-ci.yml` 及配套脚本必须随源码提交；仅安装 Runner、只把这些文件保留在工作区，不会使 GitLab 在推送时创建构建任务。当前规则对 `main` 的 push/web 创建 `upper-ci` 作业，依次执行 verify、package、publish。发布脚本使用固定的平台发布协议，客户端使用仓库内单独固定的新版下载协议快照，两者保持向后兼容。

环境 `ci` 需要 `PLATFORM_GRPC_ENDPOINT`、`PLATFORM_GRPC_PLAINTEXT`（内网为 `1`）、`PLATFORM_PUBLIC_BASE_URL`、保护且隐藏的 `PLATFORM_UPLOAD_TOKEN`，以及 `TAURI_SIGNING_PRIVATE_KEY` / 可选密码。私钥与现有公钥匹配后生成 `.sig`。跨项目读取需要允许 Upper 作业令牌访问设备协议与平台协议项目。

验证包括冻结身份与文件篡改、错误通道/流水线拒绝、无签名拒绝、GitLab 配置契约；运行现有 workflow/offline 测试、前端 lint、Rust 测试及真实 NSIS 构建。现场验收必须得到可访问的 CI 清单和下载链接，并对下载内容核对本次 SHA256。上传与发布不安装任何客户端，也不修改平台运行版本。
