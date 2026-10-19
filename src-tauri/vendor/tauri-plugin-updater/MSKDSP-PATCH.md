# MskDSP 本地安装适配

上游：`tauri-plugin-updater` crates.io 2.10.1，对应 `.cargo_vcs_info.json` 中的发布提交。完整保留发行包及 MIT/Apache-2.0/SPDX 许可。仅排除本地 Cargo 缓存标记与该独立库的 Cargo.lock；应用使用自身锁文件。

原 crates.io 发行包 SHA256：`806d9dac662c2e4594ff03c647a552f2c9bd544e7d0f683ec58f872f952ce4af`，与迁移前应用 `Cargo.lock` 一致。

变更仅在 `src/updater.rs`：增加公开离线元数据结构与构造入口，允许不配置 HTTP 更新端点；校验本机 Windows NSIS 目标、版本、签名和 gRPC 来源标识。入口不查询网络、不伪造 HTTP 清单。公开 `verify` 和 `install_verified`，后者先复用原 minisign 校验再调用原 `install_inner`；上游 HTTP 下载、原 `install` 和 NSIS 参数/退出流程保持。

应用只调用已验签入口。安装器进程创建或 Windows 进程退出不等于安装完成，仍需真实安装验收。
