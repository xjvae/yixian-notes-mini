// private — 私密层的状态与封套读写。
//
// 形状：主库里私密便签的敏感字段（标题/正文/清单/时间轴/标签）只留**空占位**，
// 真身整包住在 private.json 的 data 块里（AES-256-GCM 加密的 JSON map：便签 id → 内容）。
// 未解锁时 map 拿不到，视图看到的就是"这张便签锁着"。
//
// 图片是另一条路：字节住在 media 表（BLOB），密文用**媒体密钥**加，而那把密钥被会话
// 密钥包着存在封套里（mediaKey 字段）。为什么不拿会话密钥直接加密图片：改密（rekey）
// 就该只重裹那 32 字节，而不是把库里所有图重读重写一遍（100 张 ≈ 5 MB，失败一半 = 图
// 永久坏掉）。
//
// 纪律（对应 crypto.rs 的五条不变量）：
//  · 密钥只在内存（Zeroizing），落盘的只有盐与密文；媒体密钥也只在取用它的那一瞬存在；
//  · 落盘原子写：先 tmp 再改名，绝不留半份封套；
//  · 读到损坏的封套**不删不猜**，按"没配置"处理（宁旧不丢），现场留给日志；
//  · 重置（忘记密码）会**清空全部私密内容**——这是唯一出路（没有找回），UI 层负责把
//    这句话说清楚，Rust 侧只要求"未解锁才允许重置"。重置造的是一把**新的**媒体密钥，
//    所以旧的那些私密图字节再也解不开：命令层（commands/private.rs::private_reset）
//    负责同时把 enc=1 的 media 行删掉，不留解不开的垃圾。
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
/// 包媒体密钥那一块
const AAD_MEDIA_KEY: &[u8] = b"yixian-private-v1:media-key";
/// 每张图的 AAD 前缀。完整 AAD = 前缀 + 媒体行 id：把密文钉在自己那一行上，
/// 拿另一行的字节换进来就解不开（crypto.rs 不变量 3"换任何一个因子就是全套密文失效"）
const AAD_MEDIA: &[u8] = b"yixian-private-v1:media:";

/// 某一行媒体字节的 AAD。存与取必须传同一个 id，否则解不开
pub fn media_aad(id: &str) -> Vec<u8> {
    let mut aad = AAD_MEDIA.to_vec();
    aad.extend_from_slice(id.as_bytes());
    aad
}

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
    /// 私密图片用的密钥，被会话密钥包着。**为什么不直接用会话密钥加密图片**：
    /// 改密（rekey）只重裹这一小块 32 字节，图片字节一行都不用动。用会话密钥的话
    /// 改一次密要把库里所有图重读重写一遍（100 张 ≈ 5 MB），失败一半就是图永久坏掉。
    ///
    /// `Option` 是给 v5 之前建的老封套留的路：缺字段照样解得开（serde 默认 None），
    /// 第一次要存私密图时补上。反过来标成必填，等于用一次升级把老用户的封套判成损坏。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_key: Option<SealedBlock>,
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

/// 用会话密钥把媒体密钥包起来
fn seal_media_key(key: &[u8], media_key: &[u8]) -> AppResult<SealedBlock> {
    let (nonce, ciphertext) = crypto::seal(key, AAD_MEDIA_KEY, media_key)?;
    Ok(SealedBlock { nonce, ciphertext })
}

fn open_data_block(key: &[u8], block: &SealedBlock) -> AppResult<String> {
    let bytes = crypto::open(key, AAD_DATA, &block.nonce, &block.ciphertext)?;
    String::from_utf8(bytes).map_err(|_| AppError::new("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）"))
}

/// 造一份新封套（空 data 块 + 一把新媒体密钥）+ 会话密钥。setup 与 reset 共用，守卫各自把关。
fn create_envelope(password: &str) -> AppResult<(Envelope, Zeroizing<Vec<u8>>)> {
    crypto::validate_password(password)?;
    let kdf = KdfParams::new_random();
    let key = crypto::derive_key(password, &kdf)?;
    let (v_nonce, v_ct) = crypto::seal(&key, AAD_VERIFY, VERIFY_PLAINTEXT)?;
    let media = crypto::random_key();
    let envelope = Envelope {
        version: ENVELOPE_VERSION,
        kdf,
        verify: SealedBlock { nonce: v_nonce, ciphertext: v_ct },
        data: seal_data_block(&key, "{}")?,
        media_key: Some(seal_media_key(&key, &media)?),
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

/// 取**媒体密钥**（私密图片字节的那把钥匙）。未解锁/未配置 = PRIVATE_LOCKED。
///
/// 老封套（v5 之前建的）没有这一块：第一次要它时当场补一份并原子落盘。
/// 补在解锁会话里做，所以不存在"半份封套"（write_envelope 是 tmp + 改名），
/// 也不必为了升级把用户赶去重设口令。
pub fn media_key(vault: &PrivateVault) -> AppResult<Zeroizing<Vec<u8>>> {
    let key = vault
        .session_key()
        .ok_or_else(|| AppError::new("PRIVATE_LOCKED", "私密层未解锁"))?;
    let mut envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    if let Some(block) = &envelope.media_key {
        let raw = crypto::open(&key, AAD_MEDIA_KEY, &block.nonce, &block.ciphertext)?;
        if raw.len() != crypto::KEY_LEN {
            return Err(AppError::new(
                "CRYPTO_OPEN",
                "解密失败（口令不正确，或数据已损坏）",
            ));
        }
        return Ok(Zeroizing::new(raw));
    }
    let fresh = crypto::random_key();
    envelope.media_key = Some(seal_media_key(&key, &fresh)?);
    write_envelope(vault.dir(), &envelope)?;
    Ok(fresh)
}

/// 改密：需已解锁。新盐新密钥，data 用旧密钥解出、新密钥重封，verify 重封，
/// **媒体密钥只重裹这一小块**（库里那些图片字节一个都不动），原子落盘。
pub fn rekey(vault: &PrivateVault, new_password: &str) -> AppResult<()> {
    crypto::validate_password(new_password)?;
    let old_key = vault
        .session_key()
        .ok_or_else(|| AppError::new("PRIVATE_LOCKED", "私密层未解锁，无法修改密码"))?;
    let envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    let data_json = open_data_block(&old_key, &envelope.data)?;
    // 媒体密钥：旧钥匙开出来、新钥匙包回去，图片字节一个都不动。
    // 老封套缺这一块就继续缺着，不在这条路上补（media_key() 第一次要它时补）
    let media_raw: Option<Vec<u8>> = match envelope.media_key.as_ref() {
        Some(block) => {
            Some(crypto::open(&old_key, AAD_MEDIA_KEY, &block.nonce, &block.ciphertext)?)
        }
        None => None,
    };
    let new_kdf = KdfParams::new_random();
    let new_key = crypto::derive_key(new_password, &new_kdf)?;
    let (v_nonce, v_ct) = crypto::seal(&new_key, AAD_VERIFY, VERIFY_PLAINTEXT)?;
    let next = Envelope {
        version: ENVELOPE_VERSION,
        kdf: new_kdf,
        verify: SealedBlock { nonce: v_nonce, ciphertext: v_ct },
        data: seal_data_block(&new_key, &data_json)?,
        media_key: match &media_raw {
            Some(raw) => Some(seal_media_key(&new_key, raw)?),
            None => None,
        },
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

    /// 改密只重裹媒体密钥那一小块：**同一把密钥跨口令存活**，库里那些图片字节一个都不动。
    /// 这条就是"图片不直接用会话密钥加密"的理由，改坏了会让私密图集体变砖
    #[test]
    fn 改密后媒体密钥还是同一把() {
        let dir = temp_dir("media-key");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let before = media_key(&vault).expect("取媒体密钥");

        rekey(&vault, "换个长一点的口令").expect("改密");
        assert_eq!(
            before.as_slice(),
            media_key(&vault).expect("改密后再取").as_slice(),
            "同一把：图片不必重加密"
        );

        // 重启语义：新口令解锁后拿到的还是同一把
        let rebooted = PrivateVault::scan(&dir);
        unlock(&rebooted, "换个长一点的口令").expect("新口令解锁");
        assert_eq!(
            before.as_slice(),
            media_key(&rebooted).expect("再取").as_slice()
        );
    }

    #[test]
    fn 锁定后拿不到媒体密钥() {
        let dir = temp_dir("media-locked");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        assert!(media_key(&vault).is_ok());
        lock(&vault);
        let err = media_key(&vault).expect_err("锁定后必须拒绝");
        assert_eq!(err.code, "PRIVATE_LOCKED");
    }

    /// 重置造的是**新**媒体密钥：旧私密图字节就此解不开，所以命令层要顺手删掉它们
    #[test]
    fn 重置换掉媒体密钥_旧的解不开() {
        let dir = temp_dir("media-reset");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let old = media_key(&vault).expect("旧媒体密钥");
        let packed = crypto::seal_blob(&old, &media_aad("0123456789abcdef"), b"picture")
            .expect("用旧密钥封一张图");
        lock(&vault);
        reset(&vault, "重置后使用的新口令").expect("重置");
        let fresh = media_key(&vault).expect("新媒体密钥");
        assert_ne!(old.as_slice(), fresh.as_slice(), "重置换钥匙");
        assert!(
            crypto::open_blob(&fresh, &media_aad("0123456789abcdef"), &packed).is_err(),
            "旧图在新密钥下解不开"
        );
    }

    /// v5 之前建的封套没有 mediaKey 字段：照样算合法封套，第一次要它时补一份，
    /// 补完落盘、跨重启还是同一把（不能每次重启都换，那等于图全坏）
    #[test]
    fn 老封套缺媒体密钥_当场补上且留得住() {
        let dir = temp_dir("media-legacy");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        // 把补好的字段抹掉，伪装成 v5 之前的封套
        let raw = std::fs::read_to_string(envelope_path(&dir)).expect("读");
        let mut value: serde_json::Value = serde_json::from_str(&raw).expect("JSON");
        value
            .as_object_mut()
            .expect("对象")
            .remove("mediaKey");
        std::fs::write(envelope_path(&dir), value.to_string()).expect("写回");

        let legacy = PrivateVault::scan(&dir);
        assert!(legacy.is_configured(), "缺字段的封套仍是合法封套");
        unlock(&legacy, "口令至少八个字符").expect("解锁");
        let first = media_key(&legacy).expect("当场补一份");
        assert_eq!(first.len(), crypto::KEY_LEN);
        assert!(
            read_envelope(&dir).expect("读").expect("有").media_key.is_some(),
            "补的那份要落盘"
        );

        let rebooted = PrivateVault::scan(&dir);
        unlock(&rebooted, "口令至少八个字符").expect("再解锁");
        assert_eq!(
            first.as_slice(),
            media_key(&rebooted).expect("再取").as_slice(),
            "第二次不再造新的"
        );
    }

    #[test]
    fn 媒体_aad_按行绑定() {
        assert_eq!(media_aad("a1"), [AAD_MEDIA, &b"a1"[..]].concat());
        assert_ne!(media_aad("a1"), media_aad("a2"), "换一行就是另一套 AAD");
    }
}
