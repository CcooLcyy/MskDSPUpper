//! 固定纵密旧版叶证书兼容；不写系统证书库，不对其他连接放宽验证。
use schannel::cert_context::{CertContext, HashAlgorithm};
use schannel::cert_store::{CertAdd, CertStore, Memory};
use schannel::RawPointer;
use std::{error, fmt, io, mem, ptr};
use windows_sys::Win32::Security::Cryptography as crypt;

const APPROVED_SHA256: [u8; 32] = [
    0xe2, 0x29, 0x2d, 0x0a, 0x9c, 0x31, 0xc6, 0xb9, 0xd1, 0xa1, 0xc0, 0x7e, 0x1a, 0x2d, 0x74, 0x3e,
    0x5e, 0x29, 0x1e, 0x3d, 0x7d, 0x5a, 0xe6, 0xc5, 0xee, 0x47, 0xc3, 0xdb, 0x3c, 0x4f, 0xff, 0xc0,
];

#[derive(Debug)]
struct LegacyError {
    marker: &'static str,
    source: Option<io::Error>,
}

impl fmt::Display for LegacyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.marker)?;
        if let Some(code) = self.source.as_ref().and_then(io::Error::raw_os_error) {
            write!(f, " (os=0x{:08X})", code as u32)?;
        }
        Ok(())
    }
}

impl error::Error for LegacyError {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        self.source.as_ref().map(|source| source as _)
    }
}

pub(super) fn legacy_error(marker: &'static str, source: Option<io::Error>) -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        LegacyError { marker, source },
    )
}

pub(super) fn validate_legacy_pin(pin: &CertContext) -> io::Result<()> {
    let digest = pin.fingerprint(HashAlgorithm::sha256())?;
    if digest.as_slice() != APPROVED_SHA256 {
        return Err(legacy_error("MSKDSP_LEGACY_PIN_INVALID", None));
    }
    Ok(())
}

pub(super) fn validate_legacy_domain(domain: &str) -> io::Result<()> {
    if domain != "11.22.33.44" {
        return Err(legacy_error("MSKDSP_LEGACY_TARGET_REJECTED", None));
    }
    Ok(())
}

pub(super) fn verify_legacy_leaf(leaf: &CertContext, pin: &CertContext) -> io::Result<()> {
    validate_legacy_pin(pin)?;
    if leaf.to_der() != pin.to_der() {
        return Err(legacy_error("MSKDSP_LEGACY_CERTIFICATE_MISMATCH", None));
    }
    Ok(())
}

pub(super) fn legacy_original_error_allowed(code: i32) -> bool {
    // 仅允许到期、未知根、缺失发行者、名称不符。已知撤销、签名、用途等仍拒绝。
    matches!(
        code as u32,
        0x800B0101 | 0x800B0109 | 0x800B010A | 0x800B010F
    )
}

pub(super) fn verify_legacy_original_result(result: io::Result<()>) -> io::Result<()> {
    match result {
        Ok(()) => Ok(()),
        Err(error)
            if error
                .raw_os_error()
                .is_some_and(legacy_original_error_allowed) =>
        {
            Ok(())
        }
        Err(error) => Err(legacy_error(
            "MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED",
            Some(error),
        )),
    }
}

pub(super) struct OwnedChain {
    pub(super) raw: *mut crypt::CERT_CHAIN_CONTEXT,
    _store: CertStore,
}

impl Drop for OwnedChain {
    fn drop(&mut self) {
        // 该上下文仅由本次 CertGetCertificateChain 创建，不写入系统存储。
        unsafe { crypt::CertFreeCertificateChain(self.raw) };
    }
}

pub(super) fn legacy_chain(leaf: &CertContext, peers: &[CertContext]) -> io::Result<OwnedChain> {
    let mut store = Memory::new()?.into_store();
    for certificate in peers {
        store.add_cert(certificate, CertAdd::ReplaceExisting)?;
    }
    unsafe {
        let mut requested_usage = [crypt::szOID_PKIX_KP_SERVER_AUTH as *mut u8];
        let mut parameters: crypt::CERT_CHAIN_PARA = mem::zeroed();
        parameters.cbSize = mem::size_of_val(&parameters) as u32;
        parameters.RequestedUsage.dwType = crypt::USAGE_MATCH_TYPE_AND;
        parameters.RequestedUsage.Usage.cUsageIdentifier = 1;
        parameters.RequestedUsage.Usage.rgpszUsageIdentifier = requested_usage.as_mut_ptr();
        let mut chain = ptr::null_mut();
        // 复用原链中公开可取的证书，并再次执行同样的缓存撤销检查，避免首错误
        // 为到期/未知根时遮盖已知撤销状态。不新增网络/CRL 获取。
        let flags = crypt::CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL
            | crypt::CERT_CHAIN_DISABLE_AUTH_ROOT_AUTO_UPDATE
            | crypt::CERT_CHAIN_CACHE_END_CERT
            | crypt::CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY
            | crypt::CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
        if crypt::CertGetCertificateChain(
            ptr::null_mut(),
            leaf.as_ptr() as *const crypt::CERT_CONTEXT,
            ptr::null(),
            store.as_ptr() as crypt::HCERTSTORE,
            &parameters,
            flags,
            ptr::null(),
            &mut chain,
        ) == 0
        {
            return Err(legacy_error(
                "MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED",
                Some(io::Error::last_os_error()),
            ));
        }
        Ok(OwnedChain {
            raw: chain,
            _store: store,
        })
    }
}

pub(super) fn verify_legacy_ssl_policy(
    leaf: &CertContext,
    peers: &[CertContext],
) -> io::Result<()> {
    // 即使内部调用方误用，该函数也不能为其他证书执行限定例外。
    validate_legacy_pin(leaf)?;
    let chain = legacy_chain(leaf, peers)?;
    verify_windows_ssl_policy(chain.raw)
}

pub(super) fn verify_windows_ssl_policy(chain: *const crypt::CERT_CHAIN_CONTEXT) -> io::Result<()> {
    unsafe {
        // 原 Schannel 默认允许撤销状态未知；此处只沿用该默认并允许三类批准
        // 例外，任何其他信任位都拒绝，防止 Windows 的首错误遮盖组合错误。
        let allowed = crypt::CERT_TRUST_IS_NOT_TIME_VALID
            | crypt::CERT_TRUST_IS_UNTRUSTED_ROOT
            | crypt::CERT_TRUST_IS_PARTIAL_CHAIN
            | crypt::CERT_TRUST_REVOCATION_STATUS_UNKNOWN
            | crypt::CERT_TRUST_IS_OFFLINE_REVOCATION;
        let mut errors = (*chain).TrustStatus.dwErrorStatus;
        for i in 0..(*chain).cChain as usize {
            let simple = *(*chain).rgpChain.add(i);
            errors |= (*simple).TrustStatus.dwErrorStatus;
            for j in 0..(*simple).cElement as usize {
                errors |= (**(*simple).rgpElement.add(j)).TrustStatus.dwErrorStatus;
            }
        }
        if errors & !allowed != 0 {
            let code = if errors & crypt::CERT_TRUST_IS_REVOKED != 0 {
                0x800B010C_u32
            } else if errors & crypt::CERT_TRUST_IS_NOT_SIGNATURE_VALID != 0 {
                0x80096004
            } else if errors & crypt::CERT_TRUST_IS_NOT_VALID_FOR_USAGE != 0 {
                0x800B0110
            } else if errors & crypt::CERT_TRUST_IS_EXPLICIT_DISTRUST != 0 {
                0x800B0111
            } else {
                0x800B010B
            };
            return Err(legacy_error(
                "MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED",
                Some(io::Error::from_raw_os_error(code as i32)),
            ));
        }
        let mut name: Vec<u16> = "11.22.33.44\0".encode_utf16().collect();
        let mut extra: crypt::HTTPSPolicyCallbackData = mem::zeroed();
        extra.Anonymous.cbSize = mem::size_of_val(&extra) as u32;
        extra.dwAuthType = crypt::AUTHTYPE_SERVER;
        // 仅对已经精确匹配的旧叶证书允许这三类已知历史问题。
        extra.fdwChecks = 0x00000100 | 0x00001000 | 0x00002000;
        extra.pwszServerName = name.as_mut_ptr();
        let mut parameters: crypt::CERT_CHAIN_POLICY_PARA = mem::zeroed();
        parameters.cbSize = mem::size_of_val(&parameters) as u32;
        parameters.dwFlags = crypt::CERT_CHAIN_POLICY_ALLOW_UNKNOWN_CA_FLAG
            | crypt::CERT_CHAIN_POLICY_IGNORE_NOT_TIME_VALID_FLAG
            | crypt::CERT_CHAIN_POLICY_IGNORE_ALL_REV_UNKNOWN_FLAGS;
        parameters.pvExtraPolicyPara = &mut extra as *mut _ as *mut _;
        let mut status: crypt::CERT_CHAIN_POLICY_STATUS = mem::zeroed();
        status.cbSize = mem::size_of_val(&status) as u32;
        // Windows 返回 TRUE 仅表示执行了检查；dwError 为零才代表策略通过。
        if crypt::CertVerifyCertificateChainPolicy(
            crypt::CERT_CHAIN_POLICY_SSL,
            chain,
            &parameters,
            &mut status,
        ) == 0
        {
            return Err(legacy_error(
                "MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED",
                Some(io::Error::last_os_error()),
            ));
        }
        if status.dwError != 0 {
            return Err(legacy_error(
                "MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED",
                Some(io::Error::from_raw_os_error(status.dwError as i32)),
            ));
        }
        Ok(())
    }
}
