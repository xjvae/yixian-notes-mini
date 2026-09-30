// crypto — 私密层的密码学原语：Argon2id 派生密钥 + AES-256-GCM 封装。
//
// 五条不变量（改任何一条 = 安全变更，不是重构）：
//  1. **KDF 只有 Argon2id**，口令长度按字符数校验（8..=1024，上限防超大口令把内存钉住）；
//     上限只挡写路径，存量超长口令照样解得开（拒绝它等于把老用户锁在门外）。
//  2. **盐与 nonce 永远随机**：盐 16B 每个封套一份；nonce 12B 每次加密都换新的。
//  3. **AAD 成套**：版本 × 用途（verify/data）拼进 AEAD 的附加数据——换任何一个因子
//     就是全套密文失效，这是设计不是缺陷。
//  4. **错误只分两级**："身份不合格"（WEAK_PASSWORD）与"解不开"（CRYPTO_OPEN），
//     不细分是口令错还是密文坏——防侧信道。
//  5. **密钥零持久化**：密钥只在内存（Zeroizing 包裹，丢弃即擦除），盘上只有盐与密文。

use argon2::{Algorithm, Argon2, Params, Version};
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::support::error::AppError;

pub const KDF_ALGORITHM: &str = "argon2id";
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;
/// 校验块的已知明文：解锁 = 能解出这串字节
pub const VERIFY_PLAINTEXT: &[u8] = b"yixian-private-verify-v1";

pub const MIN_PASSWORD_CHARS: usize = 8;
pub const MAX_PASSWORD_CHARS: usize = 1024;

/// KDF 参数（与盐一起存在封套里；将来调参只影响新封套，老封套按自己的参数派生）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub algorithm: String,
    pub iterations: u32,
    pub memory_kib: u32,
    pub parallelism: u32,
    pub salt: String,
}

impl KdfParams {
    pub fn new_random() -> Self {
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        Self {
            algorithm: KDF_ALGORITHM.to_string(),
            // 64 MiB / 3 轮 / 4 线：单次派生约百毫秒级，解锁流程可接受
            iterations: 3,
            memory_kib: 65_536,
            parallelism: 4,
            salt: B64.encode(salt),
        }
    }
}

pub fn validate_password(password: &str) -> Result<(), AppError> {
    let chars = password.chars().count();
    if chars < MIN_PASSWORD_CHARS {
        return Err(AppError::new(
            "WEAK_PASSWORD",
            format!("私密密码至少需要 {MIN_PASSWORD_CHARS} 个字符"),
        ));
    }
    if chars > MAX_PASSWORD_CHARS {
        return Err(AppError::new(
            "WEAK_PASSWORD",
            format!("私密密码最长 {MAX_PASSWORD_CHARS} 个字符"),
        ));
    }
    Ok(())
}

/// 口令 → 32 字节密钥。参数来自封套（老封套按老参数派生，保证老口令解得开）。
pub fn derive_key(password: &str, params: &KdfParams) -> Result<Zeroizing<Vec<u8>>, AppError> {
    if params.algorithm != KDF_ALGORITHM {
        return Err(AppError::new(
            "CRYPTO_OPEN",
            format!("不认识的 KDF 算法 {}", params.algorithm),
        ));
    }
    let salt = B64.decode(&params.salt)
        .map_err(|_| AppError::new("CRYPTO_OPEN", "封套盐值损坏"))?;
    let mut key = Zeroizing::new(vec![0u8; KEY_LEN]);
    let argon_params = Params::new(params.memory_kib, params.iterations, params.parallelism, Some(KEY_LEN))
        .map_err(|e| AppError::new("CRYPTO_OPEN", format!("KDF 参数不合法：{e}")))?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params)
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|e| AppError::new("CRYPTO_OPEN", format!("密钥派生失败：{e}")))?;
    Ok(key)
}

/// 加密一个块。随机 nonce；AAD 区分用途。返回 (nonce_b64, ciphertext_b64)。
pub fn seal(
    key: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<(String, String), AppError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::new("CRYPTO_OPEN", "密钥长度异常"))?;
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: plaintext, aad },
        )
        .map_err(|_| AppError::new("CRYPTO_ENCRYPT", "加密失败"))?;
    Ok((B64.encode(nonce), B64.encode(ciphertext)))
}

/// 解密一个块。任何失败（口令错、密文坏、AAD 不对）一律同一个错——不细分原因。
pub fn open(
    key: &[u8],
    aad: &[u8],
    nonce: &str,
    ciphertext: &str,
) -> Result<Vec<u8>, AppError> {
    let nonce_bytes = B64.decode(nonce)
        .map_err(|_| AppError::new("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）"))?;
    let ciphertext_bytes = B64.decode(ciphertext)
        .map_err(|_| AppError::new("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）"))?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::new("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）"))?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &ciphertext_bytes,
                aad,
            },
        )
        .map_err(|_| AppError::new("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 口令长度按字符数校验() {
        assert!(validate_password(&"短".repeat(MIN_PASSWORD_CHARS - 1)).is_err());
        assert!(validate_password(&"长".repeat(MIN_PASSWORD_CHARS)).is_ok());
        // 多字节字符按字符数算，不按字节数
        assert!(validate_password(&"密".repeat(MAX_PASSWORD_CHARS)).is_ok());
        assert!(validate_password(&"超".repeat(MAX_PASSWORD_CHARS + 1)).is_err());
    }

    #[test]
    fn 封装往返_错误口令解不开() {
        let params = KdfParams::new_random();
        let key = derive_key("正确的口令", &params).expect("派生");
        let (nonce, ciphertext) = seal(&key, b"aad", VERIFY_PLAINTEXT).expect("加密");

        let opened = open(&key, b"aad", &nonce, &ciphertext).expect("解密");
        assert_eq!(opened, VERIFY_PLAINTEXT);

        let wrong = derive_key("错误的口令", &params).expect("派生");
        let err = open(&wrong, b"aad", &nonce, &ciphertext).expect_err("必须失败");
        assert_eq!(err.code, "CRYPTO_OPEN", "错误只分两级，不细分哪一步");
    }

    #[test]
    fn aad_不匹配也解不开_盐随机_口令相同密文不同() {
        let params = KdfParams::new_random();
        let key = derive_key("口令口令口令", &params).expect("派生");
        let (nonce, ciphertext) = seal(&key, b"verify", VERIFY_PLAINTEXT).expect("加密");
        assert!(open(&key, b"data", &nonce, &ciphertext).is_err(), "AAD 成套");

        let (n1, c1) = seal(&key, b"aad", VERIFY_PLAINTEXT).expect("加密1");
        let (n2, c2) = seal(&key, b"aad", VERIFY_PLAINTEXT).expect("加密2");
        assert_ne!(n1, n2, "nonce 每次随机");
        assert_ne!(c1, c2, "同明文两次加密密文不同");

        let other = KdfParams::new_random();
        assert_ne!(other.salt, params.salt, "盐随机");
    }
}
