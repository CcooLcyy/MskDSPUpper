"""在内存转换用户授权的配套证书，不打印或落盘原口令及明文私钥。"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
import secrets
import struct
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, padding, serialization
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.serialization import pkcs12


def properties(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith(("#", "!")) and "=" in line:
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip()
    return result


def original_passwords(source: Path) -> tuple[bytes, bytes]:
    code = properties(source / "NSS3000 V1.1.E.4242/config.properties")["Pcoding"]
    java = (source / "analysis/full-restoration/source/netkeeper/util/AesCoding.java").read_text(encoding="utf-8")
    block = java.split("String getNum()", 1)[1].split("private AesCoding", 1)[0]
    iv = "".join(re.findall(r"append\((\d+)\)", block)).encode("ascii")
    key = code[24:40].encode("ascii")
    if len(key) != 16 or len(iv) != 16:
        raise ValueError("Unsupported original configuration")

    def decrypt(ciphertext: str) -> bytes:
        decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        padded = decryptor.update(base64.b64decode(ciphertext, validate=True)) + decryptor.finalize()
        unpadder = padding.PKCS7(128).unpadder()
        return unpadder.update(padded) + unpadder.finalize()

    return decrypt(code[:24]), decrypt(code[40:])


def jks_certificates(data: bytes, password: bytes) -> list[bytes]:
    """验证 JKS 完整性，只提取公共证书，不解出 JKS 私钥条目。"""
    digest = hashlib.sha1(password.decode("utf-8").encode("utf-16-be") + b"Mighty Aphrodite" + data[:-20]).digest()
    if not hmac.compare_digest(digest, data[-20:]):
        raise ValueError("JKS verification failed")
    offset = 0

    def take(length: int) -> bytes:
        nonlocal offset
        if length < 0 or offset + length > len(data) - 20:
            raise ValueError("JKS record boundary")
        value = data[offset:offset + length]
        offset += length
        return value

    def integer() -> int:
        return struct.unpack(">i", take(4))[0]

    def utf() -> bytes:
        return take(struct.unpack(">H", take(2))[0])

    if take(4) != bytes.fromhex("feedfeed"):
        raise ValueError("JKS magic")
    version = integer()
    count = integer()
    if version not in (1, 2) or not 0 <= count <= 64:
        raise ValueError("JKS version or count")
    certificates = []
    for _ in range(count):
        kind = integer()
        utf()
        take(8)
        if kind == 1:
            take(integer())
            chain_count = integer()
        elif kind == 2:
            chain_count = 1
        else:
            raise ValueError("JKS entry type")
        if not 0 <= chain_count <= 64:
            raise ValueError("JKS chain count")
        for _ in range(chain_count):
            if version == 2 and utf() != b"X.509":
                raise ValueError("JKS certificate type")
            encoded = take(integer())
            x509.load_der_x509_certificate(encoded)
            if encoded not in certificates:
                certificates.append(encoded)
    if offset != len(data) - 20 or not certificates:
        raise ValueError("JKS trailing records")
    return certificates


def certificate_metadata(certificate: x509.Certificate) -> dict:
    public_key = certificate.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return {
        "subject": certificate.subject.rfc4514_string(),
        "issuer": certificate.issuer.rfc4514_string(),
        "not_before": certificate.not_valid_before_utc.isoformat(),
        "not_after": certificate.not_valid_after_utc.isoformat(),
        "valid_from_unix": int(certificate.not_valid_before_utc.timestamp()),
        "valid_until_unix": int(certificate.not_valid_after_utc.timestamp()),
        "sha256": certificate.fingerprint(hashes.SHA256()).hex(),
        "public_key_sha256": hashlib.sha256(public_key).hexdigest(),
    }


def prepare(source: Path, destination: Path) -> dict:
    store_password, key_password = original_passwords(source)
    certificate_dir = source / "NSS3000 V1.1.E.4242/使用的证书"
    outputs = {}
    profiles = []
    for identifier, suffix in (("old", ""), ("new", "New")):
        original = (certificate_dir / f"client{suffix}.p12").read_bytes()
        key, certificate, chain = pkcs12.load_key_and_certificates(original, key_password)
        if key is None or certificate is None:
            raise ValueError("Client identity missing")
        public_format = (serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if key.public_key().public_bytes(*public_format) != certificate.public_key().public_bytes(*public_format):
            raise ValueError("Identity public key mismatch")
        trust = jks_certificates((certificate_dir / f"tclient{suffix}.jks").read_bytes(), store_password)
        seed = secrets.token_bytes(32)
        bundle_password = hashlib.sha256(seed).hexdigest().encode("ascii")
        # 使用 Windows SChannel 可导入的 PKCS12 编码；此静态身份可从安装包提取。
        encryption = (serialization.PrivateFormat.PKCS12.encryption_builder()
                      .kdf_rounds(20000)
                      .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
                      .hmac_hash(hashes.SHA1()).build(bundle_password))
        bundle = pkcs12.serialize_key_and_certificates(f"mskdsp-vertical-{identifier}".encode(), key, certificate, chain, encryption)
        parsed_key, parsed_certificate, _ = pkcs12.load_key_and_certificates(bundle, bundle_password)
        if parsed_key.public_key().public_bytes(*public_format) != parsed_certificate.public_key().public_bytes(*public_format):
            raise ValueError("Repacked identity public key mismatch")
        identity_file = f"builtin-{identifier}.p12"
        unlock_file = f"builtin-{identifier}.unlock"
        outputs[identity_file] = bundle
        outputs[unlock_file] = seed
        trust_files = []
        for index, encoded in enumerate(trust):
            filename = f"builtin-{identifier}-trust-{index}.der"
            outputs[filename] = encoded
            trust_files.append(filename)
        profiles.append({"id": identifier, "identity_file": identity_file, "unlock_file": unlock_file,
                         "trust_files": trust_files, "client": certificate_metadata(certificate),
                         "identity_key_matches": True,
                         "trust": [certificate_metadata(x509.load_der_x509_certificate(encoded)) for encoded in trust]})
    manifest = {"schema_version": 1, "source": "NSS3000 V1.1.E.4242 配套证书（用户授权内嵌）", "profiles": profiles}
    destination.mkdir(parents=True, exist_ok=True)
    for filename, content in outputs.items():
        (destination / filename).write_bytes(content)
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return {"profiles": len(profiles), "trust_certificates": sum(len(profile["trust"]) for profile in profiles), "identity_key_matches": True}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--verify-output", action="store_true", help="仅核验已有内置资源，不改写随机资源")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "src-tauri/resources/vertical-security")
    args = parser.parse_args()
    try:
        if args.verify_output:
            summary = verify_output(args.output.resolve())
        else:
            if args.source is None:
                parser.error("preparation requires --source")
            summary = prepare(args.source.resolve(), args.output.resolve())
    except Exception as error:
        # 不输出异常正文：第三方异常可能携带口令或原材料内容。
        raise SystemExit(f"Certificate preparation failed ({type(error).__name__}); no secret details printed") from None
    print(json.dumps(summary))


def verify_output(directory: Path) -> dict:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    count = 0
    for profile in manifest["profiles"]:
        seed = (directory / profile["unlock_file"]).read_bytes()
        bundle_password = hashlib.sha256(seed).hexdigest().encode("ascii")
        key, certificate, _ = pkcs12.load_key_and_certificates((directory / profile["identity_file"]).read_bytes(), bundle_password)
        public_format = (serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if key is None or certificate is None or key.public_key().public_bytes(*public_format) != certificate.public_key().public_bytes(*public_format):
            raise ValueError("Embedded identity key mismatch")
        if certificate_metadata(certificate) != profile["client"]:
            raise ValueError("Embedded client metadata mismatch")
        if len(profile["trust_files"]) != len(profile["trust"]):
            raise ValueError("Embedded trust count mismatch")
        for filename, expected in zip(profile["trust_files"], profile["trust"]):
            if certificate_metadata(x509.load_der_x509_certificate((directory / filename).read_bytes())) != expected:
                raise ValueError("Embedded trust metadata mismatch")
        count += 1
    if count != 2:
        raise ValueError("Embedded identity count mismatch")
    return {"verified_profiles": count, "identity_key_matches": True, "public_validity_metadata_matches": True}


if __name__ == "__main__":
    main()
