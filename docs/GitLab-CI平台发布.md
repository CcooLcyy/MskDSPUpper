# 上位机 CI 包接入平台

现行入口见 [上位机发布约定](../RELEASING.md)。以下记录已退役的 GitLab 构建缓存和平台接入流程。GitLab Windows Runner 完成检查、固定提交构建和 NSIS 打包，经平台 gRPC 续传、校验入库，再显式发布 CI 通道。发布后读取公开目录、清单及下载安装包核对 SHA256。

沿用现有 `emit-build-metadata`、`apply-channel-version`、`render-tauri-config`、`stage-release`。协议按 `platform-proto.ref` 固定提交获取，设备协议子模块仅在 GitLab 作业内改为同实例地址，GitHub 兼容发布仍使用其现有子模块配置。Runner 可通过 `RUNNER_ENV_PATH` 注入工具环境，不把机器目录写入源码。

编译阶段必须导入 x64 MSVC 与 Windows SDK 环境。`VSDEVCMD` 可指定开发环境脚本；默认从 `RUNNER_ENV_ROOT/tools/vs2022/Common7/Tools/VsDevCmd.bat` 读取。脚本通过 `cmd /c call ... && set` 在内存中导入环境，不打印完整环境或认证材料。签名密码未配置时，Node 子进程显式传入空密码，避免 Windows PowerShell 删除空环境变量后触发交互。

## CI 构建提速

前端依赖在 Runner 现有工作区的 `node_modules` 内复用，GitLab 检出只对这个目录设置清理例外。缓存身份包含锁文件、依赖配置和 Node/npm 工具链等安装输入；只接受成功完成锁定安装后产生的标记，命中前检查依赖完整性。身份变化、标记缺失或依赖缺损时重新执行 `npm ci`，失败不能留下可复用标记。该目录仍位于原有 `C:\gitlab-runner` 根内，不使用指向个人环境的链接。

为修复 Node 测试运行器对中文标准输出的反序列化异常，verify/package 在导入 MSVC 环境后使用固定 Node 24.22.2 便携运行环境。缓存位于 `RUNNER_ENV_ROOT/cache/mskdsp-upper-node`，未配置环境根时使用作业工作区 `.ci-tools/node`；只覆盖当前作业 PATH，不修改 Runner 全局 Node。下载及复用均校验官方固定 SHA256 与实际安装文件，失败阻止后续步骤；不回退旧版本或重试失败用例。安装细节和原始失败证据见 [CI 测试运行器反序列化修复](../doc/CI测试运行器反序列化修复.md)。

完整 Python CI 脚本测试先执行；随后前端依赖准备、workflow/offline 测试和严格 lint 与 Rust 测试在独立进程中并行。两个分支都成功后才进入 package；任一分支失败都会阻止打包，等待另一分支退出后返回失败，异常或中断则清理已启动的子进程。验证输出与分支耗时写入 `package/logs`，便于定位失败与比较并行效果。所有通道统一使用 `upper-windows-cargo` resource group，防止共享 Cargo 目录在编译与回收时发生跨作业竞争。

GitLab Rust 验证使用 `cargo test --release`，保留原有 Rust 测试，不再为该验证生成 Debug profile 的编译产物。`.gitlab-ci.yml` 默认 `CARGO_INCREMENTAL=0`；`pipeline.ps1` 在 Runner 与 MSVC 环境导入完成后，为 verify 和 package 统一设置 `CARGO_INCREMENTAL=1`、Release 优化等级 `3` 和 `16` 个 codegen units；GitHub 兼容工作流不受影响。Release 测试仍需要独立的 test harness，测试依赖启用的 features 也可能与正式打包不同，不能保证测试和打包完全共用编译缓存。首次建立 Release 测试缓存可能更慢，实际耗时与复用收益以对应提交的 CI 日志为准。

现有版本时间戳规则保持不变，发布脚本每轮仍改写 Cargo 的包版本。版本参与 crate 身份计算，因此主程序跨版本的增量目录会变化，不能假定下一条流水线命中上一版本的主程序缓存。依赖仍按既有规则复用，不能把缓存启用等同于已证明提速。签名、源码身份冻结和公开下载验收继续完整执行。

编译缓存按保留当前任务和最近成功构建所需产物的原则回收旧内容，清理时必须避开活动任务及其正在使用的文件。旧 Debug 产物的清理仅限本项目确认使用的缓存目录，不清理其他项目或共享工具链；保留的 Release 缓存继续供后续构建复用。

`cargo_cache.py` 在目标目录的 `.upper-cache` 内保存项目身份和构建记录。稳定路径的 workspace wrapper 仅将上位机主项目的 incremental 输出改到按测试基础版本或打包版本命名的目录；第三方依赖仍使用原缓存。测试和打包的 Cargo JSON（包括 Fresh 事件）用于记录精确产物及构建脚本目录。完整成功构建保留本次和上一成功记录；失败、取消或记录不完整不能推进成功记录。原有无归属的主项目历史缓存先保留，至少两次受管构建完整成功后才回收已确认不再使用的主项目旧缓存；其他项目、第三方依赖、未知目录及工具链不在回收范围。首次引入 workspace wrapper 会使主项目建立新的编译身份，不代表依赖需要全部重编。

构建结束的回收清单写入 `package/logs/cargo-cache-retention.json`；可使用 `finish --dry-run` 查看计划而不修改状态或删除文件。不得绕过路径身份、重解析点和完整记录检查来清理未知目录。

验证基线为流水线 #51：作业约 588 秒，依赖安装约 91 秒，Rust Release 编译 279 秒。优化验收需要至少一次建立缓存和一次后续运行，分别记录依赖命中、并行区间、编译耗时和平台包校验结果。

CI 产物身份为 `mskdsp-upper`、`windows-x86_64-nsis`、完整源码 SHA、GitLab 仓库地址和现有 CI SemVer。上传前以及发布前核对远端 main；过时任务保留构建产物但不能改写通道。任务串行发布；认证材料仅从保护变量读取，不进入命令参数或产物。

平台现有上位机产品强制要求真实 Tauri 签名。使用现有验签公钥对应私钥，不生成替代公钥。缺少私钥时停止发布构建，不能用占位签名宣称成功。平台 HTTP 公共地址用于清单与安装包，gRPC 上传仅允许 TLS 或显式内网 IP。

客户端已经切换平台 gRPC 查询与下载安装包；生成的 CI 配置统一清空 updater HTTP 端点，使用本地适配的 Tauri updater 2.10.1 验签和手动安装，不依赖 HTTP `latest.json`，也不回退 GitHub/R2。平台 HTTP 公共地址仍用于发布后的旧客户端兼容清单及实际下载安装包验收。`stage-release` 不传 GitHub 仓库或静态下载地址，因此跳过本地 `latest.json`，由平台生成兼容下载清单；冻结脚本从 staging 清单取唯一 NSIS 和对应签名。

`.gitlab-ci.yml` 及配套脚本必须随源码提交；仅安装 Runner、只把这些文件保留在工作区，不会使 GitLab 在推送时创建构建任务。当前规则对 `main`、受保护的 `release/X.Y` 和正式标签创建对应流水线，按 verify、package、publish 顺序执行；维护分支仅保留产物，不改写公共通道。发布脚本使用固定的平台发布协议，客户端使用仓库内单独固定的新版下载协议快照，两者保持向后兼容。

环境 `ci` 需要 `PLATFORM_GRPC_ENDPOINT`、`PLATFORM_GRPC_PLAINTEXT`（内网为 `1`）、`PLATFORM_PUBLIC_BASE_URL`、保护且掩码的 `PLATFORM_UPLOAD_TOKEN`，以及 `TAURI_SIGNING_PRIVATE_KEY` / 可选密码。私钥与现有公钥匹配后生成 `.sig`。跨项目读取需要允许 Upper 作业令牌访问设备协议与平台协议项目。

验证包括冻结身份与文件篡改、错误通道/流水线拒绝、无签名拒绝、GitLab 配置契约；运行现有 workflow/offline 测试、前端 lint、Rust 测试及真实 NSIS 构建。现场验收必须得到可访问的 CI 清单和下载链接，并对下载内容核对本次 SHA256。上传与发布不安装任何客户端，也不修改平台运行版本。

## Windows 验签夹具的检出约束

流水线 #39 / 作业 #203 在 Rust 验签测试失败：仓库内 36 字节 LF 输入经 Runner 文本转换后变为 37 字节 CRLF，原签名因此不能通过。根目录 `.gitattributes` 对该文件指定 `-text`，保证所有平台按原始字节检出；新增真实 `core.autocrlf=true` 克隆回归，原签名验证继续保留。

已有 Runner 工作区不会仅因新增 Git 属性就重写内容未变的输入文件。因此 `before_script` 在测试前从当前 HEAD 恢复该单一验签输入；不清理整个工作区或编译缓存。回归同时覆盖全新克隆和从旧 CRLF 工作区升级两种情形。
