//! 仅本机证书策略及回环 fixture；不连接纵密设备或发送账号。
use super::mskdsp_legacy::legacy_original_error_allowed;
use super::*;

fn approved() -> Certificate {
    Certificate::from_der(include_bytes!(
        "../../../../resources/vertical-security/builtin-old-trust-0.der"
    ))
    .unwrap()
}

#[test]
fn mskdsp_legacy_pin_accepts_only_approved_certificate_and_fixed_target() {
    let cert = approved();
    assert!(validate_legacy_pin(&cert.0).is_ok());
    assert!(validate_legacy_domain("11.22.33.44").is_ok());
    for domain in ["server", "127.0.0.1", "11.22.33.45", "11.22.33.44:8888"] {
        assert!(validate_legacy_domain(domain)
            .unwrap_err()
            .to_string()
            .contains("MSKDSP_LEGACY_TARGET_REJECTED"));
    }
    let other = Certificate::from_der(include_bytes!(
        "../../../../resources/vertical-security/builtin-new-trust-0.der"
    ))
    .unwrap();
    assert!(validate_legacy_pin(&other.0)
        .unwrap_err()
        .to_string()
        .contains("MSKDSP_LEGACY_PIN_INVALID"));
}

#[test]
fn mskdsp_legacy_leaf_must_match_exact_der() {
    let pin = approved();
    assert!(verify_legacy_leaf(&pin.0, &pin.0).is_ok());
    let other = Certificate::from_der(include_bytes!(
        "../../../../resources/vertical-security/builtin-new-trust-0.der"
    ))
    .unwrap();
    assert!(verify_legacy_leaf(&other.0, &pin.0)
        .unwrap_err()
        .to_string()
        .contains("MSKDSP_LEGACY_CERTIFICATE_MISMATCH"));
}

#[test]
fn mskdsp_legacy_policy_only_allows_known_date_name_and_ca_errors() {
    for code in [0x800B0101u32, 0x800B0109, 0x800B010A, 0x800B010F] {
        assert!(legacy_original_error_allowed(code as i32));
    }
    for code in [
        0x800B0106u32,
        0x800B010C,
        0x800B0110,
        0x80096004,
        0x800B010E,
        0x800B0111,
    ] {
        assert!(!legacy_original_error_allowed(code as i32));
    }
}

#[test]
fn mskdsp_legacy_approved_certificate_passes_only_scoped_windows_ssl_policy() {
    let cert = approved();
    verify_legacy_ssl_policy(&cert.0, &[]).unwrap();
}

#[test]
fn mskdsp_legacy_builder_defaults_off_and_rejects_arbitrary_pin() {
    assert!(crate::TlsConnector::builder().mskdsp_legacy_pin.is_none());
    let cert = crate::Certificate::from_der(include_bytes!(
        "../../../../resources/vertical-security/builtin-new-trust-0.der"
    ))
    .unwrap();
    let error = crate::TlsConnector::builder()
        .mskdsp_legacy_certificate_pin(cert)
        .build()
        .unwrap_err();
    assert!(error.to_string().contains("MSKDSP_LEGACY_PIN_INVALID"));
}

#[test]
fn mskdsp_legacy_windows_policy_still_rejects_other_trust_errors() {
    use super::mskdsp_legacy::{legacy_chain, verify_windows_ssl_policy};
    use std::{ptr, slice};
    let leaf = approved();
    for flag in [
        crypt::CERT_TRUST_IS_NOT_SIGNATURE_VALID,
        crypt::CERT_TRUST_IS_REVOKED,
        crypt::CERT_TRUST_IS_NOT_VALID_FOR_USAGE,
        crypt::CERT_TRUST_IS_EXPLICIT_DISTRUST,
        crypt::CERT_TRUST_INVALID_BASIC_CONSTRAINTS,
        crypt::CERT_TRUST_HAS_NOT_SUPPORTED_CRITICAL_EXT,
        crypt::CERT_TRUST_IS_NOT_TIME_VALID | crypt::CERT_TRUST_IS_REVOKED,
        crypt::CERT_TRUST_IS_UNTRUSTED_ROOT | crypt::CERT_TRUST_IS_NOT_SIGNATURE_VALID,
    ] {
        let owned = legacy_chain(&leaf.0, &[]).unwrap();
        // 仅复制测试上下文并注入一个信任位；不修改系统返回的上下文或证书。
        // SSL 策略必须真正拒绝，而不能因为精确 pin 就直接返回成功。
        unsafe {
            let mut context = ptr::read(owned.raw);
            let mut chains =
                slice::from_raw_parts(context.rgpChain, context.cChain as usize).to_vec();
            let mut simple = ptr::read(chains[0]);
            let mut elements =
                slice::from_raw_parts(simple.rgpElement, simple.cElement as usize).to_vec();
            let mut element = ptr::read(elements[0]);
            context.TrustStatus.dwErrorStatus |= flag;
            simple.TrustStatus.dwErrorStatus |= flag;
            element.TrustStatus.dwErrorStatus |= flag;
            elements[0] = &mut element;
            simple.rgpElement = elements.as_mut_ptr();
            chains[0] = &mut simple;
            context.rgpChain = chains.as_mut_ptr();
            let error =
                verify_windows_ssl_policy(&context).expect_err(&format!("flag=0x{flag:08X}"));
            assert!(error
                .to_string()
                .contains("MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED"));
        }
    }
}

#[test]
fn mskdsp_legacy_original_validation_failure_retains_stable_code() {
    let error =
        verify_legacy_original_result(Err(io::Error::from_raw_os_error(0x800B010Cu32 as i32)))
            .unwrap_err();
    assert!(error
        .to_string()
        .contains("MSKDSP_LEGACY_CERTIFICATE_VALIDATION_FAILED"));
    assert!(error.to_string().contains("os=0x800B010C"));
}

#[test]
fn mskdsp_legacy_wrong_domain_is_rejected_before_transport_access() {
    struct Untouched;
    impl io::Read for Untouched {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            panic!("目标拒绝之前不能读取传输流")
        }
    }
    impl io::Write for Untouched {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            panic!("目标拒绝之前不能写入传输流")
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("目标拒绝之前不能刷新传输流")
        }
    }
    let cert = crate::Certificate::from_der(include_bytes!(
        "../../../../resources/vertical-security/builtin-old-trust-0.der"
    ))
    .unwrap();
    let connector = crate::TlsConnector::builder()
        .mskdsp_legacy_certificate_pin(cert)
        .build()
        .unwrap();
    match connector.connect("127.0.0.1", Untouched) {
        Err(crate::HandshakeError::Failure(error)) => {
            assert!(error.to_string().contains("MSKDSP_LEGACY_TARGET_REJECTED"))
        }
        _ => panic!("必须在访问传输之前拒绝非固定目标"),
    }
}

#[test]
fn mskdsp_legacy_builder_rejects_global_validation_bypass() {
    for bypass_certificate in [true, false] {
        let cert = crate::Certificate::from_der(include_bytes!(
            "../../../../resources/vertical-security/builtin-old-trust-0.der"
        ))
        .unwrap();
        let mut builder = crate::TlsConnector::builder();
        builder.mskdsp_legacy_certificate_pin(cert);
        if bypass_certificate {
            builder.danger_accept_invalid_certs(true);
        } else {
            builder.danger_accept_invalid_hostnames(true);
        }
        assert!(builder
            .build()
            .unwrap_err()
            .to_string()
            .contains("MSKDSP_LEGACY_POLICY_CONFLICT"));
    }
}
