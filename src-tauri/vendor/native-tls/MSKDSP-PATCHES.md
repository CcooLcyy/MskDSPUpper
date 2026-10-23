# native-tls 本地补丁

- 来源：`rust-native-tls/rust-native-tls`，crates.io `native-tls` 0.2.18。
- 原始包 checksum：`465500e14ea162429d264d44189adc38b199b62b1c21eea9f69e4b73cb03bbf2`。
- 许可证：保留上游 `LICENSE-MIT`、`LICENSE-APACHE`。
- 本地仅保留库源码、构建脚本、清单和许可证；不引入上游测试、测试证书、锁文件或构建产物。

## Windows PKCS12 私钥生命周期

上游 `src/imp/schannel.rs` 的 `Identity::from_pkcs12` 使用默认 `PfxImportOptions`。
实际核对的依赖为 `schannel` 0.1.29，其 `src/cert_store.rs` 中默认 flags 为 0，
`no_persist_key` 文档明确说明默认会将私钥持久化到磁盘，必须自行清理。
检查时本机源码位于 `%USERPROFILE%/.cargo/registry/src/mirrors.ustc.edu.cn-38d0e5eb5da2abae/schannel-0.1.29/src/cert_store.rs`。

本地在该导入调用中强制 `.no_persist_key(true)`，设置 Windows 的 `PKCS12_NO_PERSIST_KEY`。
应用及 `tokio-native-tls` 均通过 Cargo 的 path/patch 引用这一份实现，避免同时链接未修补版本。
其余 TLS 协议、证书链与服务器名称校验保持上游行为。

验收使用上位机的纯 fixture 登录测试以及源代码核对；本轮没有导入真实客户端证书，
没有访问或修改 Windows 证书存储。实际装置、证书算法与 SChannel 的兼容性仍需联调。
