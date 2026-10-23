//! 用户授权的原软件配套身份。资源与解锁种子随程序分发，可提取，不能替代账号认证。
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub(super) const MANIFEST: &str = include_str!("../../resources/vertical-security/manifest.json");

#[derive(Clone, Copy)]
pub(super) struct Validity {
    pub from: i64,
    pub until: i64,
}

impl Validity {
    pub fn contains(self, now: i64) -> bool {
        self.from <= now && now <= self.until
    }
}

pub(super) struct BuiltinIdentity {
    pub id: &'static str,
    pub identity: &'static [u8],
    pub unlock_seed: &'static [u8],
    pub trust: &'static [&'static [u8]],
}

impl BuiltinIdentity {
    pub fn validity(&self) -> Result<Validity, String> {
        let manifest: serde_json::Value =
            serde_json::from_str(MANIFEST).map_err(|_| "内置证书元数据损坏".to_string())?;
        let profile = manifest["profiles"]
            .as_array()
            .and_then(|profiles| {
                profiles
                    .iter()
                    .find(|profile| profile["id"].as_str() == Some(self.id))
            })
            .ok_or_else(|| "内置证书来源信息缺失".to_string())?;
        let trust = profile["trust"]
            .as_array()
            .ok_or_else(|| "内置证书信任信息缺失".to_string())?;
        if trust.len() != self.trust.len() {
            return Err("内置证书信任信息不匹配".into());
        }
        let mut validity = Validity {
            from: i64::MIN,
            until: i64::MAX,
        };
        for certificate in std::iter::once(&profile["client"]).chain(trust.iter()) {
            let from = certificate["valid_from_unix"]
                .as_i64()
                .ok_or_else(|| "内置证书有效期缺失".to_string())?;
            let until = certificate["valid_until_unix"]
                .as_i64()
                .ok_or_else(|| "内置证书有效期缺失".to_string())?;
            if from > until {
                return Err("内置证书有效期无效".into());
            }
            validity.from = validity.from.max(from);
            validity.until = validity.until.min(until);
        }
        Ok(validity)
    }
}

pub(super) const IDENTITIES: &[BuiltinIdentity] = &[
    BuiltinIdentity {
        id: "old",
        identity: include_bytes!("../../resources/vertical-security/builtin-old.p12"),
        unlock_seed: include_bytes!("../../resources/vertical-security/builtin-old.unlock"),
        trust: &[include_bytes!(
            "../../resources/vertical-security/builtin-old-trust-0.der"
        )],
    },
    BuiltinIdentity {
        id: "new",
        identity: include_bytes!("../../resources/vertical-security/builtin-new.p12"),
        unlock_seed: include_bytes!("../../resources/vertical-security/builtin-new.unlock"),
        trust: &[include_bytes!(
            "../../resources/vertical-security/builtin-new-trust-0.der"
        )],
    },
];

pub(super) fn bundle_password(seed: &[u8]) -> Zeroizing<String> {
    Zeroizing::new(
        Sha256::digest(seed)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}
