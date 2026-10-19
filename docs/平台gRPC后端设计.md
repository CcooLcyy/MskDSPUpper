# 平台 gRPC 软件更新后端

上下位机网络软件更新统一读取持久设置 `softwarePlatformGrpcEndpoint`，默认 `http://192.168.10.198:50000`。明文仅允许回环或私有 IP，HTTPS 使用系统可信根并校验服务器身份；不回退静态清单、HTTP 安装包或 R2。设备协议子模块保持不变，平台协议使用 `proto-platform/platform/v1/software.proto` 的可追溯快照。

目录按产品、架构及通道查询。下载必须先通过 `GetPackage` 重新确认公开包身份、当前通道、文件名、大小和 SHA256；下载流只允许连续偏移、每块不超过 256 KiB、完整大小与摘要不变，最后必须出现 EOF。中断后按已落盘长度续传，大小与 SHA256 全部验证后才替换可安装包。错误元数据、错误偏移、超限、缺失 EOF 与损坏内容均不能进入安装状态。公开目录不允许访问平台候选程序包。

上位机新增 `check_app_update`、`download_app_update(task_id)`、`install_app_update`、`dispose_app_update`。信息沿用 camelCase `currentVersion/version/date/body/rawJson`，rawJson 包含平台包 ID、SHA256、通道和架构。下载事件 `app-update-download-progress` 携带 `task_id` 及既有 Started/Progress/Finished。检查只更新待下载候选；下载新包失败保留原可安装包。CI 按版本/摘要身份差异识别候选，不依赖 SemVer 大小。安装前重新核对文件和原 Tauri 公钥签名，复用 Tauri NSIS 安装语义，不创建伪 HTTP 清单。

当前安装的完整版本字符串与候选相等时返回已最新；候选及尚未安装缓存用包 ID/摘要区分。ready 状态仅属于本进程；重新打开应用后先查询平台，再按 SHA256 文件名复用并重新验签匹配缓存。成功替换会删除本进程上一 ready 文件；跨进程无索引的历史 SHA 缓存暂可能积累，本轮不自动遍历删除其他历史文件。

下位机清单增加可选 `platform_package_id`。在线包只能通过平台 ID 下载，清单元数据必须与重新查询到的平台包一致。原本地导入、缓存、SSH 上传和设备安装流程保持；已有缓存可离线安装。新网络下载不接受旧 HTTP 清单作为降级来源。

验证采用随机回环端口的真实 tonic 目录/流服务，覆盖目录筛选、连续下载、断线续传、错误身份、错误偏移、大小/摘要变化、EOF 缺失及损坏文件。另验证已下载状态保留、签名拒绝、持久设置与前端 DTO 契约。源码和本地测试通过不等同于现场升级验收；现场只在确认真实签名包后执行受控安装。

本轮 Windows 本地验证：`cargo test --locked --all-targets` 的 132 项库测试全部通过，二进制测试入口为 0 项、不计覆盖；`cargo build --locked` 正常生成桌面程序。验签使用独立临时测试密钥生成的公开夹具，损坏内容明确返回 minisign 验证错误，从未运行有效安装器。修改文件的 rustfmt 与差异空白检查通过；全仓格式检查仍报告未触及 AGC/AVC/设备 gRPC 等文件的既有格式差异，本轮没有批量改写这些文件。

Windows 单元测试新增离线安装代码后也需要 Common Controls v6。已比对锁定的 `tauri-build 2.5.6` 默认 `windows-app-manifest.xml`：原文只有这一依赖，没有 UAC、DPI 或 longPath 字段。本轮将相同依赖统一交给 linker 嵌入，Tauri 资源库继续生成原图标和版本；通过 `/MANIFESTUAC:NO` 抑制 linker 额外产生的 trustInfo。已从测试二进制提取实际清单，逐项核对 assemblyIdentity 与原模板相等且没有额外 trustInfo；正常桌面程序构建亦通过。
