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

真实解析测试还验证了临时私钥需要通过 `CRYPT_ACQUIRE_CACHE_FLAG` 获取。该句柄由证书上下文持有，
不能按上游非缓存句柄的方式立即释放；Windows 缓存路径不会自动比较公钥，因此本地只导出
`CERT_PUBLIC_KEY_INFO` 并调用 `CertComparePublicKeyInfo`，保持客户端公私钥一致性检查。
没有导出私钥，也没有回退到持久化导入。额外的 Windows API 依赖仅用于该生命周期与公共信息检查。

依据：[CryptAcquireCertificatePrivateKey 的缓存及所有权说明](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-cryptacquirecertificateprivatekey)、
[CryptExportPublicKeyInfo 的公共密钥导出说明](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-cryptexportpublickeyinfo)。

验收包含上位机的纯 fixture 登录测试、源代码核对，以及用户授权的两组配套客户端资源的
离线实际解析与进程内临时导入、公私钥对应关系检查；没有写入持久证书存储或密钥容器。
本轮没有连接真实装置、发送账号材料或运行网络配置。真实服务端的 TLS 与名称兼容性仍需联调。
