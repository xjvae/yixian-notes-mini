// private — 私密层的状态与封套读写。
//
// 形状：主库里私密便签的敏感字段（标题/正文/清单/时间轴/标签）只留**空占位**，
// 真身整包住在 private.json 的 data 块里（AES-256-GCM 加密的 JSON map：便签 id → 内容）。
// 未解锁时 map 拿不到，视图看到的就是"这张便签锁着"。
//
// 纪律（对应 crypto.rs 的五条不变量）：
//  · 密钥只在内存（Zeroizing），落盘的只有盐与密文；
//  · 落盘原子写：先 tmp 再改名，绝不留半份封套；
//  · 读到损坏的封套**不删不猜**，按"没配置"处理（宁旧不丢），现场留给日志；
//  · 重置（忘记密码）会**清空全部私密内容**——这是唯一出路（没有找回），UI 层负责把
//    这句话说清楚，Rust 侧只要求"未解锁才允许重置"。
//
// 并发口径：所有重活（派生/加解密/文件 IO）都在 spawn_blocking 里跑（commands 层包）；
// 本模块的函数是同步的，不持任何跨 await 的锁。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::crypto::{
    self, KdfParams, VERIFY_PLAINTEXT,
};
use crate::support::error::{AppError, AppResult};
use crate::support::log;

const ENVELOPE_FILE: &str = "private.json";
const ENVELOPE_VERSION: u32 = 1;
const AAD_VERIFY: &[u8] = b"yixian-private-v1:verify";
const AAD_DATA: &[u8] = b"yixian-private-v1:data";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SealedBlock {
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub version: u32,
    pub kdf: KdfParams,
    pub verify: SealedBlock,
    pub data: SealedBlock,
}

/// 管理态：configured = 盘上有合法封套；key = 已解锁的会话密钥（只在内存）。
#[derive(Clone)]
pub struct PrivateVault {
    dir: PathBuf,
    inner: Arc<Mutex<VaultInner>>,
}

#[derive(Default)]
struct VaultInner {
    configured: bool,
    key: Option<Zeroizing<Vec<u8>>>,
}

impl PrivateVault {
    /// 启动时扫一次：盘上有合法封套才算配置过（损坏按没配置算，现场进日志）
    pub fn scan(dir: &Path) -> Self {
        let configured = match read_envelope(dir) {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(message) => {
                log::warn("private", &format!("私密封套读取失败，按未配置处理：{message}"));
                false
            }
        };
        Self {
            dir: dir.to_path_buf(),
            inner: Arc::new(Mutex::new(VaultInner {
                configured,
                key: None,
            })),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn is_configured(&self) -> bool {
        self.lock().configured
    }

    pub fn is_unlocked(&self) -> bool {
        self.lock().key.is_some()
    }

    pub fn session_key(&self) -> Option<Zeroizing<Vec<u8>>> {
        self.lock().key.clone()
    }

    pub fn set_unlocked(&self, key: Zeroizing<Vec<u8>>) {
        let mut inner = self.lock();
        inner.configured = true;
        inner.key = Some(key);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VaultInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn envelope_path(dir: &Path) -> PathBuf {
    dir.join(ENVELOPE_FILE)
}

/// 读封套。不存在 → Ok(None)；存在但损坏 → Err（损坏文件留在原地，不删不猜）。
pub fn read_envelope(dir: &Path) -> Result<Option<Envelope>, String> {
    let path = envelope_path(dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读不到 {}: {e}", path.display())),
    };
    serde_json::from_str::<Envelope>(&raw)
        .map(Some)
        .map_err(|e| format!("{} 不是合法封套：{e}", path.display()))
}

/// 原子写：tmp → 改名。改名同盘原子，中途断电不留半份。
fn write_envelope(dir: &Path, envelope: &Envelope) -> AppResult<()> {
    let path = envelope_path(dir);
    let tmp = dir.join(".private.json.tmp");
    let json = serde_json::to_string_pretty(envelope)
        .map_err(|e| AppError::new("PRIVATE_WRITE", e.to_string()))?;
    std::fs::write(&tmp, json)
        .map_err(|e| AppError::new("PRIVATE_WRITE", format!("写临时文件失败：{e}")))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| AppError::new("PRIVATE_WRITE", format!("落盘失败：{e}")))?;
    Ok(())
}

fn seal_data_block(key: &[u8], data_json: &str) -> AppResult<SealedBlock> {
    let (nonce, ciphertext) = crypto::seal(key, AAD_DATA, data_json.as_bytes())?;
    Ok(SealedBlock { nonce, ciphertext })
}

fn open_data_block(key: &[u8], block: &SealedBlock) -> AppResult<String> {
    let bytes = crypto::open(key, AAD_DATA, &block.nonce, &block.ciphertext)?;
    String::from_utf8(bytes).map_err(|_| AppError::new("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）"))
}

/// 造一份新封套（空 data 块）+ 会话密钥。setup 与 reset 共用，守卫各自把关。
fn create_envelope(password: &str) -> AppResult<(Envelope, Zeroizing<Vec<u8>>)> {
    crypto::validate_password(password)?;
    let kdf = KdfParams::new_random();
    let key = crypto::derive_key(password, &kdf)?;
    let (v_nonce, v_ct) = crypto::seal(&key, AAD_VERIFY, VERIFY_PLAINTEXT)?;
    let envelope = Envelope {
        version: ENVELOPE_VERSION,
        kdf,
        verify: SealedBlock { nonce: v_nonce, ciphertext: v_ct },
        data: seal_data_block(&key, "{}")?,
    };
    Ok((envelope, key))
}

/// 首次设置：新盐 + 新密钥，verify 与 data（空 map）两个块一起封好落盘。
pub fn setup(vault: &PrivateVault, password: &str) -> AppResult<()> {
    if vault.is_configured() {
        return Err(AppError::new(
            "ALREADY_CONFIGURED",
            "私密层已经设置过，请直接解锁或修改密码",
        ));
    }
    let (envelope, key) = create_envelope(password)?;
    write_envelope(vault.dir(), &envelope)?;
    vault.set_unlocked(key);
    Ok(())
}

/// 解锁：按封套里的 KDF 参数派生，解 verify 块验明口令，密钥留在内存。
pub fn unlock(vault: &PrivateVault, password: &str) -> AppResult<()> {
    let envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    let key = crypto::derive_key(password, &envelope.kdf)?;
    let opened = crypto::open(&key, AAD_VERIFY, &envelope.verify.nonce, &envelope.verify.ciphertext)?;
    if opened != VERIFY_PLAINTEXT {
        // 到不了这里（AEAD tag 已判完），留着是防御：错误口径不变
        return Err(AppError::new("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）"));
    }
    vault.set_unlocked(key);
    Ok(())
}

/// 锁定：只丢内存里的密钥，盘上封套原样。
pub fn lock(vault: &PrivateVault) {
    vault.lock().key = None;
}

/// 读私密内容（整份 JSON map）。未解锁/未配置 = PRIVATE_LOCKED。
pub fn load_data(vault: &PrivateVault) -> AppResult<String> {
    let key = vault
        .session_key()
        .ok_or_else(|| AppError::new("PRIVATE_LOCKED", "私密层未解锁"))?;
    let envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    open_data_block(&key, &envelope.data)
}

/// 写私密内容：整份 map 重新加密（fresh nonce）后原子落盘。
pub fn save_data(vault: &PrivateVault, data_json: &str) -> AppResult<()> {
    let key = vault
        .session_key()
        .ok_or_else(|| AppError::new("PRIVATE_LOCKED", "私密层未解锁"))?;
    let parsed: serde_json::Value = serde_json::from_str(data_json)
        .map_err(|e| AppError::new("PRIVATE_DATA", format!("私密内容不是合法 JSON：{e}")))?;
    if !parsed.is_object() {
        return Err(AppError::new("PRIVATE_DATA", "私密内容必须是 JSON 对象"));
    }
    let mut envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    envelope.data = seal_data_block(&key, data_json)?;
    write_envelope(vault.dir(), &envelope)?;
    Ok(())
}

/// 改密：需已解锁。新盐新密钥，data 用旧密钥解出、新密钥重封，verify 重封，原子落盘。
pub fn rekey(vault: &PrivateVault, new_password: &str) -> AppResult<()> {
    crypto::validate_password(new_password)?;
    let old_key = vault
        .session_key()
        .ok_or_else(|| AppError::new("PRIVATE_LOCKED", "私密层未解锁，无法修改密码"))?;
    let envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    let data_json = open_data_block(&old_key, &envelope.data)?;
    let new_kdf = KdfParams::new_random();
    let new_key = crypto::derive_key(new_password, &new_kdf)?;
    let (v_nonce, v_ct) = crypto::seal(&new_key, AAD_VERIFY, VERIFY_PLAINTEXT)?;
    let next = Envelope {
        version: ENVELOPE_VERSION,
        kdf: new_kdf,
        verify: SealedBlock { nonce: v_nonce, ciphertext: v_ct },
        data: seal_data_block(&new_key, &data_json)?,
    };
    write_envelope(vault.dir(), &next)?;
    vault.set_unlocked(new_key);
    Ok(())
}

/// 重置（忘记密码的唯一出路）：**清空全部私密内容**，换成新口令的新封套。
/// 只允许在未解锁时走——已解锁就该用改密，不该有绕过旧口令的擦除通道。
pub fn reset(vault: &PrivateVault, new_password: &str) -> AppResult<()> {
    if vault.is_unlocked() {
        return Err(AppError::new(
            "RESET_WHEN_UNLOCKED",
            "已解锁的会话请用「修改密码」，重置会清空私密内容",
        ));
    }
    if !vault.is_configured() {
        return Err(AppError::new("PRIVATE_MISSING", "私密层还没有设置"));
    }
    log::warn("private", "私密层重置：旧私密内容全部清除");
    // 不能走 setup：重置合法前提就是"已配置但未解锁"，setup 的守卫会把它拒掉
    let (envelope, key) = create_envelope(new_password)?;
    write_envelope(vault.dir(), &envelope)?;
    vault.set_unlocked(key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yixian-private-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    #[test]
    fn 设置_解锁_读写_改密_整链路() {
        let dir = temp_dir("full");
        let vault = PrivateVault::scan(&dir);
        assert!(!vault.is_configured());

        setup(&vault, "口令至少八个字符").expect("设置");
        assert!(vault.is_configured() && vault.is_unlocked());

        save_data(&vault, r#"{"s1":{"title":"真身","body":""}}"#).expect("写");
        let data = load_data(&vault).expect("读");
        assert!(data.contains("真身"));

        rekey(&vault, "新口令也要八个字符").expect("改密");
        // 旧内容还在（data 块用新密钥重封）
        assert!(load_data(&vault).expect("读").contains("真身"));
        // 重启语义：新 vault 实例用新口令解得开
        let rebooted = PrivateVault::scan(&dir);
        unlock(&rebooted, "新口令也要八个字符").expect("新口令解锁");
        assert!(load_data(&rebooted).expect("读").contains("真身"));
        assert!(unlock(&rebooted, "口令至少八个字符").is_err(), "旧口令作废");
    }

    #[test]
    fn 锁定后读不到_重启后未解锁() {
        let dir = temp_dir("lock");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        save_data(&vault, r#"{"s1":{}}"#).expect("写");
        lock(&vault);
        assert!(!vault.is_unlocked());
        assert!(load_data(&vault).is_err(), "锁定后拿不到私密内容");

        let rebooted = PrivateVault::scan(&dir);
        assert!(rebooted.is_configured(), "重启仍知已配置");
        assert!(!rebooted.is_unlocked(), "密钥不跨进程");
    }

    #[test]
    fn 解锁错口令_错误两级不细分() {
        let dir = temp_dir("wrong");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        lock(&vault);
        let err = unlock(&vault, "错误口令八字").expect_err("必须失败");
        assert_eq!(err.code, "CRYPTO_OPEN");
    }

    #[test]
    fn 已解锁时不许重置_要走改密() {
        let dir = temp_dir("reset-locked");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置"); // setup 后即进入解锁会话
        save_data(&vault, r#"{"s1":{"title":"内容"}}"#).expect("写");
        let err = reset(&vault, "重置后使用的新口令").expect_err("已解锁必须走改密");
        assert_eq!(err.code, "RESET_WHEN_UNLOCKED");
        assert!(load_data(&vault).expect("读").contains("内容"), "内容原样还在");
    }

    #[test]
    fn 损坏封套按未配置算_文件不删() {
        let dir = temp_dir("corrupt");
        std::fs::write(envelope_path(&dir), "不是封套").expect("写坏文件");
        let vault = PrivateVault::scan(&dir);
        assert!(!vault.is_configured());
        assert!(envelope_path(&dir).exists(), "现场不删");
    }

    #[test]
    fn 原子写不留临时文件() {
        let dir = temp_dir("atomic");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        assert!(envelope_path(&dir).exists());
        assert!(!dir.join(".private.json.tmp").exists(), "tmp 已改名");
    }

    // 上面"重置"用例里留了一条防呆断言，把口径写正：
    // 未解锁 = 重置的合法前提（用户忘了口令，正因未解锁）。
    #[test]
    fn 未解锁是重置的合法前提() {
        let dir = temp_dir("reset-valid");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        save_data(&vault, r#"{"s1":{}}"#).expect("写");
        lock(&vault);
        reset(&vault, "重置后使用的新口令").expect("未解锁时重置合法");
        assert_eq!(load_data(&vault).expect("读"), "{}");
    }
}
