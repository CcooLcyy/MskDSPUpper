# native-tls 本地补丁

- 来源：`rust-native-tls/rust-native-tls`，crates.io `native-tls` 0.2.18。
- 原始包 checksum：`465500e14ea162429d264d44189adc38b199b62b1c21eea9f69e4b73cb03bbf2`。
- 许可证：保留上游 `LICENSE-MIT`、`LICENSE-APACHE`。
- 本地保留库源码、构建脚本、清单、许可证及本地策略测试；不引入上游测试证书、独立锁文件或构建产物。

## Windows PKCS12 私钥生命周期

上游 `src/imp/schannel.rs` 的 `Identity::from_pkcs12` 使用默认 `PfxImportOptions`。
实际核对的依赖为 `schannel` 0.1.29，其 `src/cert_store.rs` 中默认 flags 为 0，
`no_persist_key` 文档明确说明默认会将私钥持久化到磁盘，必须自行清理。
检查时本机源码位于 `%USERPROFILE%/.cargo/registry/src/mirrors.ustc.edu.cn-38d0e5eb5da2abae/schannel-0.1.29/src/cert_store.rs`。

本地在该导入调用中强制 `.no_persist_key(true)`，设置 Windows 的 `PKCS12_NO_PERSIST_KEY`。
应用及 `tokio-native-tls` 均通过 Cargo 的 path/patch 引用这一份实现，避免同时链接未修补版本。
未显式启用下面的纵密旧版 pin 扩展时，TLS 协议、证书链与服务器名称校验保持上游行为。

真实解析测试还验证了临时私钥需要通过 `CRYPT_ACQUIRE_CACHE_FLAG` 获取。该句柄由证书上下文持有，
不能按上游非缓存句柄的方式立即释放；Windows 缓存路径不会自动比较公钥，因此本地只导出
`CERT_PUBLIC_KEY_INFO` 并调用 `CertComparePublicKeyInfo`，保持客户端公私钥一致性检查。
没有导出私钥，也没有回退到持久化导入。额外的 Windows API 依赖仅用于该生命周期与公共信息检查。

依据：[CryptAcquireCertificatePrivateKey 的缓存及所有权说明](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-cryptacquirecertificateprivatekey)、
[CryptExportPublicKeyInfo 的公共密钥导出说明](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-cryptexportpublickeyinfo)。

验收包含上位机的纯 fixture 登录测试、源代码核对，以及用户授权的两组配套客户端资源的
离线实际解析与进程内临时导入、公私钥对应关系检查；没有写入持久证书存储或密钥容器。
本轮没有连接真实装置、发送账号材料或运行网络配置。真实服务端的 TLS 与名称兼容性仍需联调。

## Windows 固定纵密旧证书兼容

新增仅 Windows 的 `TlsConnectorBuilder::mskdsp_legacy_certificate_pin(Certificate)`，默认关闭。
构建时及每次连接时验证配置证书的 SHA256 必须为
`e2292d0a9c31c6b9d1a1c07e1a2d743e5e291e3d7d5ae6c5ee47c3db3c4fffc0`；
连接的 TLS domain 必须精确为 `11.22.33.44`。上位机另固定 TCP 目标为 `.44:8888`，
此通用流 API 无法从任意 `Read + Write` 流中取得网络地址或端口。
该扩展不接受与 `danger_accept_invalid_certs` 或 `danger_accept_invalid_hostnames` 同时启用。

验证回调只核对 `res.chain().get(0)` 叶证书的完整 DER，不使用任意链成员匹配。
先检查原 Schannel 结果，只有已知的日期、未知根／发行者及名称错误才能进入兼容流程。
原错误在白名单内也不能直接成功：把回调链的公开证书复制到进程内 Memory store，
以 `serverAuth` 用途重新构建链，执行与原 Schannel 一样的缓存撤销检查，
并禁止 URL 获取和自动根更新，不新增在线 CRL 或其他网络访问。

重新检查整个链上下文、每个简单链和每个元素的全部信任错误位，避免“到期”或
“未知根”作为首错误时遮盖已知撤销、签名或用途错误。
仅允许批准旧证书的日期、未知 CA／缺失发行者，以及原 Schannel 已有的
撤销状态未知／离线语义。其他信任错误一律拒绝，包括已知撤销、签名无效、
用途不符、显式不信任、基本约束和不支持的关键扩展。
随后仍须执行 `CERT_CHAIN_POLICY_SSL`，仅增加旧证书的未知 CA、日期及名称例外，
保留原 Schannel 的 `IGNORE_ALL_REV_UNKNOWN_FLAGS`；
API 返回 TRUE 且 `CERT_CHAIN_POLICY_STATUS.dwError == 0` 才能通过。

Schannel 回调提供最终简单链，特殊 CTL／多简单链可能与实际 TLS 叶不同。
因此交付 TLS 流前还要用 `peer_certificate()` 再次精确核对实际远端叶，
同步完成及 `WouldBlock` 异步恢复路径均执行此检查，账号材料只能在流交付后发送。
证书及策略仅在进程内使用，不写系统证书存储，已有 `no_persist_key` 补丁保持不变。

错误使用固定 marker，验证失败另带 `os=0xXXXXXXXX`，不包含账号、私钥或原始报文：

- `MSKDSP_LEGACY_PIN_INVALID`：配置的 pin 不是批准旧证书。
- `MSKDSP_LEGACY_TARGET_REJECTED`：TLS domain 不是固定目标。
- `MSKDSP_LEGACY_POLICY_CONFLICT`：同时启用了全局证书或名称绕过选项。
- `MSKDSP_LEGACY_CERTIFICATE_MISMATCH`：实际叶 DER 不符或缺少叶证书。
- `MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED`：原检查或限定 Windows SSL 策略仍失败。

验证命令（复用上位机锁文件和 target，不生成独立 vendor 锁文件）：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --locked -p native-tls --lib mskdsp_legacy
```

测试验证批准旧 DER 的实际 Windows 策略能通过，并给复制的链上下文注入
撤销、签名、用途等错误及“到期＋撤销”“未知根＋签名错误”组合，确认均被拒绝。
真实 TLS 的本地随机端口正反例由上位机 `security_login` 测试覆盖，不发送账号。

依据：[CERT_SIMPLE_CHAIN 的叶证书顺序](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/ns-wincrypt-cert_simple_chain)、
[HTTPSPolicyCallbackData 的 SSL 例外标志](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/ns-wincrypt-httpspolicycallbackdata)、
[CERT_CHAIN_POLICY_PARA 的链策略标志](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/ns-wincrypt-cert_chain_policy_para)、
[CertGetCertificateChain 的缓存及禁止联网标志](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certgetcertificatechain)、
[CertVerifyCertificateChainPolicy 的双重返回值及撤销检查说明](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certverifycertificatechainpolicy)。
