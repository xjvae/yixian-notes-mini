// private — 私密层封套 + "哪一张此刻开着"。
// master（Argon2id 派生）只活在验口令、解或包那一张钥匙的操作里，用完即丢、不常驻内存，
// 所以没有"整层开着"这个状态；每把自己一把随机密钥（`private_keys`），被 master 包着存库，
// 这张的正文/历史/图都在其下、别的张解不开；内存里只放已揭开那张的密钥（revealed），一次口令只开一张。
// 封套 `private.json` 只留口令验证材料与 mediaKey/contentKey 两把旧钥匙（存量旧数据迁移用；新封套不写 contentKey）。
// 纪律见 crypto.rs 五条不变量：密钥只在内存(Zeroizing)、封套原子写、坏封套按未配置处理不删不猜、版本不认识就拒、错误只分"身份不合格/解不开"两级防侧信道。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::crypto::{self, KdfParams, VERIFY_PLAINTEXT};
use crate::support::error::{AppError, AppResult};
use crate::support::{clock, log};

const ENVELOPE_FILE: &str = "private.json";
/// 这一版程序写的封套形状
const ENVELOPE_VERSION: u32 = 2;
/// 还读得懂的旧形状：v1 = 整份私密正文的 map 住在这个文件里（迁移见 `legacy_map`）
const LEGACY_MAP_VERSION: u32 = 1;

// AAD 里那个 `v1` 是**域分隔符**，不是封套版本号：改它等于让所有存量密文当场失效。
// 封套版本走 `Envelope.version`，两者互不相关。
const AAD_VERIFY: &[u8] = b"yixian-private-v1:verify";
const AAD_MEDIA_KEY: &[u8] = b"yixian-private-v1:media-key";
const AAD_CONTENT_KEY: &[u8] = b"yixian-private-v1:content-key";
/// v1 那个 data 块的 AAD。迁移之外不再有新写入，但老封套还得解得开
const AAD_DATA_V1: &[u8] = b"yixian-private-v1:data";
/// 每张图的 AAD 前缀：把密文钉在自己那一行上，换一行就解不开
const AAD_MEDIA: &[u8] = b"yixian-private-v1:media:";
const AAD_CONTENT: &[u8] = b"yixian-private-v1:content:";
const AAD_REVISION: &[u8] = b"yixian-private-v1:revision:";
const AAD_NOTE_KEY: &[u8] = b"yixian-private-v1:note-key:";

fn aad(prefix: &[u8], tail: &[u8]) -> Vec<u8> {
    let mut out = prefix.to_vec();
    out.extend_from_slice(tail);
    out
}

/// 某一行媒体字节的 AAD。存与取必须传同一个 id
pub fn media_aad(id: &str) -> Vec<u8> {
    aad(AAD_MEDIA, id.as_bytes())
}

/// 某一张私密正文的 AAD（绑 id：换一张就是另一套）
pub fn content_aad(id: &str) -> Vec<u8> {
    aad(AAD_CONTENT, id.as_bytes())
}

/// 某一张的某一版的 AAD。`seq` 参与：那条密文挪个 seq 就解不开
pub fn revision_aad(id: &str, seq: i64) -> Vec<u8> {
    let mut out = aad(AAD_REVISION, id.as_bytes());
    out.push(b'/');
    out.extend_from_slice(seq.to_string().as_bytes());
    out
}

/// 某一张那把钥匙的 AAD：这条密文钥匙钉在自己那张上，挪到另一张就解不开
pub fn note_key_aad(id: &str) -> Vec<u8> {
    aad(AAD_NOTE_KEY, id.as_bytes())
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
    /// 旧所有私密图共用的那把钥匙（存量图还在其下）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_key: Option<SealedBlock>,
    /// 旧逐条密文共用的那把钥匙（有键行的那张不再用它）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_key: Option<SealedBlock>,
    /// v1 的形状：整份 `id → 内容 + 历史` 的 map。只为迁移而读
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<SealedBlock>,
}

/// 口令派生出来的那把 master。`Zeroizing` 是硬要求（见 crypto.rs 不变量 1），
/// 单列一个名字也让 `(Master, Master)` 这种返回值读得下去
type Master = Zeroizing<Vec<u8>>;

/// 管理态：configured = 盘上有合法封套；revealed = **已揭开的那几张**自己的钥匙。
#[derive(Clone)]
pub struct PrivateVault {
    dir: PathBuf,
    inner: Arc<Mutex<VaultInner>>,
}

#[derive(Default)]
struct VaultInner {
    configured: bool,
    /// 盘上那份读不出来（JSON 坏了 / 版本不认识）。与"没配置"是两回事：那种是干净起点，
    /// 这种是**有东西但打不开**——行上的密文仍属一把来路不明的 master，写路径不能当它不存在
    damage: Option<String>,
    revealed: HashMap<String, Zeroizing<Vec<u8>>>,
}

impl PrivateVault {
    /// 启动时扫一次：盘上有合法封套才算配置过；损坏那份留在原地不删不猜，只记下坏在哪
    pub fn scan(dir: &Path) -> Self {
        let (configured, damage) = match read_envelope(dir) {
            Ok(Some(_)) => (true, None),
            Ok(None) => (false, None),
            Err(message) => {
                log::warn("private", &format!("私密封套读不出来：{message}"));
                (false, Some(message))
            }
        };
        Self {
            dir: dir.to_path_buf(),
            inner: Arc::new(Mutex::new(VaultInner {
                configured,
                damage,
                ..Default::default()
            })),
        }
    }

    /// 测试与"私密层没启用"那条路用：不落盘的空 vault（`is_configured()` 永远假），目录指向临时区免得误写碰仓库。
    #[cfg(test)]
    pub fn disabled(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "yixian-vault-disabled-{}-{}",
            tag,
            crate::support::clock::now_ms()
        ));
        Self::scan(&dir)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn is_configured(&self) -> bool {
        self.lock().configured
    }

    /// 那份封套读不出来。给状态广播用（前端据此别再摆"设置口令"那张脸）
    pub fn is_damaged(&self) -> bool {
        self.lock().damage.is_some()
    }

    /// 坏在哪、往哪个文件看。Some = 这一拍碰私密就该停，消息里带着路径与唯一出路
    pub fn damage(&self) -> Option<AppError> {
        self.lock().damage.clone().map(|message| {
            AppError::new(
                "PRIVATE_DAMAGED",
                format!(
                    "私密封套读不出来，私密便签先别动：{message}\n\
                     能救的路只有把那份文件修回去（快照里同名目录带着配套封套）；\
                     认了放弃就用「重置私密密码」，旧私密内容全部清空。"
                ),
            )
        })
    }

    /// 这一张此刻开着吗。**只有开着的张**参与解密与合并
    pub fn is_revealed(&self, id: &str) -> bool {
        self.lock().revealed.contains_key(id)
    }

    /// 有没有**任何**一张开着。自动上锁那条循环问的是这一格（没有开着的张就没什么可锁）
    pub fn any_revealed(&self) -> bool {
        !self.lock().revealed.is_empty()
    }

    /// 已揭开的有哪些（给 `private_status`：前端蒙不蒙每一张都问这一格）
    pub fn revealed_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.lock().revealed.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// 那张的钥匙。没揭开 → None（调用方按"锁着"处理，不许拿别的张的钥匙凑）
    pub fn revealed_key(&self, id: &str) -> Option<Zeroizing<Vec<u8>>> {
        self.lock().revealed.get(id).cloned()
    }

    /// 揭开那一张：只把这一张的钥匙放进内存
    pub fn reveal(&self, id: &str, key: Zeroizing<Vec<u8>>) {
        let mut inner = self.lock();
        inner.configured = true;
        inner.revealed.insert(id.to_string(), key);
    }

    /// 封套被换过了（快照恢复那条路）：内存里的 configured 与 damage 按**盘上现在这份**重算。
    /// 不重算的话：换进来一份好封套而内存还记着 damaged，私密写永远被拒；反过来更坏——
    /// 换进来的那份读不出来而界面仍当它是好的
    pub fn rescan(&self) {
        let (configured, damage) = match read_envelope(&self.dir) {
            Ok(Some(_)) => (true, None),
            Ok(None) => (false, None),
            Err(message) => {
                log::warn("private", &format!("换进来的私密封套读不出来：{message}"));
                (false, Some(message))
            }
        };
        let mut inner = self.lock();
        inner.configured = configured;
        inner.damage = damage;
        inner.revealed.clear();
    }

    /// 封套落盘后同步内存：configured 置真、damage 抹掉（刚写进去的那份就是当前真相）。
    /// 漏了它 setup 后 status 仍报"没设置"、`plan()` 会把整行明文写进主库。
    fn mark_configured(&self) {
        let mut inner = self.lock();
        inner.configured = true;
        inner.damage = None;
    }

    /// 收回**全部**已揭开的钥匙：逐张模型没有"只锁一层"的半动作，一次擦干净、所有私密便签同时回蒙版。
    pub fn hide_all(&self) {
        self.lock().revealed.clear();
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

/// 迁移留底那份的名字：`private.json.migrated-<epoch 毫秒>`
pub fn migrated_file_name(now_ms: i64) -> String {
    format!("{ENVELOPE_FILE}.migrated-{now_ms}")
}

/// 读封套：不存在→Ok(None)；坏(JSON 不合法/版本不认识)→Err，损坏文件留在原地不删不猜。
pub fn read_envelope(dir: &Path) -> Result<Option<Envelope>, String> {
    let path = envelope_path(dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读不到 {}: {e}", path.display())),
    };
    let parsed: Envelope = serde_json::from_str(&raw)
        .map_err(|e| format!("{} 不是合法封套：{e}", path.display()))?;
    // 版本不认就停：往下猜等于拿形状不对的封套去解一库密文，那错只表现为"口令不对"、查不到根上
    if parsed.version != ENVELOPE_VERSION && parsed.version != LEGACY_MAP_VERSION {
        return Err(format!(
            "{} 是 v{} 封套，这份程序只认 v{ENVELOPE_VERSION}（以及读得懂用于迁移的 v{LEGACY_MAP_VERSION}）",
            path.display(),
            parsed.version
        ));
    }
    Ok(Some(parsed))
}

/// 原子落一份文件：tmp → sync → 改名。改名同盘原子，中途断电不留半份；**sync 在改名之前**是必须的——
/// Windows 上 rename 只保证元数据落定，字节可能还留在系统缓存里，断电就留下"名字对了、内容全零"
/// 的那一份。封套自己写、以及快照恢复换封套，共用这一条
pub fn write_atomic(dir: &Path, path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = dir.join(format!(".{}.tmp", path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("private.json")));
    {
        let mut file = std::fs::File::create(&tmp)
            .map_err(|e| AppError::new("PRIVATE_WRITE", format!("写临时文件失败：{e}")))?;
        file.write_all(bytes)
            .map_err(|e| AppError::new("PRIVATE_WRITE", format!("写临时文件失败：{e}")))?;
        file.sync_all()
            .map_err(|e| AppError::new("PRIVATE_WRITE", format!("临时文件没落到盘上：{e}")))?;
    }
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::new("PRIVATE_WRITE", format!("落盘失败：{e}")))?;
    Ok(())
}

fn write_envelope(dir: &Path, envelope: &Envelope) -> AppResult<()> {
    let json = serde_json::to_vec_pretty(envelope)
        .map_err(|e| AppError::new("PRIVATE_WRITE", e.to_string()))?;
    write_atomic(dir, &envelope_path(dir), &json)
}

fn crypto_open() -> AppError {
    AppError::new("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）")
}

/// 口令→master 并验其对上封套，**唯一**消费口令处；解不开不区分"口令错/封套坏"（防侧信道，见不变量 4）。
pub fn master_of(vault: &PrivateVault, password: &str) -> AppResult<Zeroizing<Vec<u8>>> {
    Ok(master_and_envelope(vault, password)?.0)
}

/// 同上、连封套一起给：揭开一张既要 master 验身份、又要读封套旧钥匙搬旧数据，分两次读就是同一份材料解两遍。
pub fn master_and_envelope(
    vault: &PrivateVault,
    password: &str,
) -> AppResult<(Zeroizing<Vec<u8>>, Envelope)> {
    let envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    let master = crypto::derive_key(password, &envelope.kdf)?;
    let opened = crypto::open(
        &master,
        AAD_VERIFY,
        &envelope.verify.nonce,
        &envelope.verify.ciphertext,
    )?;
    if opened != VERIFY_PLAINTEXT {
        // 到不了这里（AEAD tag 已判完），留着是防御：错误口径不变
        return Err(crypto_open());
    }
    Ok((master, envelope))
}

/// 从封套解出那把**旧**整层钥匙，只给"把这张搬进逐张钥匙"那步用；搬完 master 即丢、这两把不再取用。
fn unwrap_wrapped(
    master: &[u8],
    block: Option<&SealedBlock>,
    which_aad: &[u8],
) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
    let Some(block) = block else {
        return Ok(None);
    };
    let raw = crypto::open(master, which_aad, &block.nonce, &block.ciphertext)?;
    if raw.len() != crypto::KEY_LEN {
        return Err(crypto_open());
    }
    Ok(Some(Zeroizing::new(raw)))
}

/// 旧逐条密文共用的那把整层钥匙（`contentKey`）。封套里没有 → None = 没有旧数据要迁
pub fn legacy_content_key(envelope: &Envelope, master: &[u8]) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
    unwrap_wrapped(master, envelope.content_key.as_ref(), AAD_CONTENT_KEY)
}

/// 旧所有私密图共用的那把整层钥匙（`mediaKey`）
pub fn legacy_media_key(envelope: &Envelope, master: &[u8]) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
    unwrap_wrapped(master, envelope.media_key.as_ref(), AAD_MEDIA_KEY)
}

/// 旧形状逐条密文用的整层钥匙，缺就当场补一把、已有就原样解回复用——断点重跑必须拿到同一把，
/// 换一把等于把已搬过去的行永远锁死。"有旧形状行却没这把钥匙"的对不上号由调用方先把守，这一格不补。
pub fn ensure_legacy_content_key(
    vault: &PrivateVault,
    master: &[u8],
) -> AppResult<Zeroizing<Vec<u8>>> {
    let mut envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    if let Some(existing) =
        unwrap_wrapped(master, envelope.content_key.as_ref(), AAD_CONTENT_KEY)?
    {
        return Ok(existing);
    }
    let key = crypto::random_key();
    envelope.content_key = Some(seal_wrapped(master, AAD_CONTENT_KEY, &key)?);
    // 只是**补一个字段**：version 与 data 原样留——迁移没跑完就把 v1 写成 v2，等于表里还没那些行时丢了唯一旧 map
    write_envelope(vault.dir(), &envelope)?;
    Ok(key)
}

fn seal_wrapped(master: &[u8], which_aad: &[u8], raw: &[u8]) -> AppResult<SealedBlock> {
    let (nonce, ciphertext) = crypto::seal(master, which_aad, raw)?;
    Ok(SealedBlock { nonce, ciphertext })
}

/// 把一张的钥匙用 master 包起来（存 `private_keys.key` 那一列）
pub fn seal_note_key(master: &[u8], id: &str, key: &[u8]) -> AppResult<Vec<u8>> {
    crypto::seal_blob(master, &note_key_aad(id), key)
}

/// 解出某一张的钥匙。id 对不上（拿另一张的密文钥匙过来）就是解不开
pub fn open_note_key(master: &[u8], id: &str, packed: &[u8]) -> AppResult<Zeroizing<Vec<u8>>> {
    let raw = crypto::open_blob(master, &note_key_aad(id), packed)?;
    if raw.len() != crypto::KEY_LEN {
        return Err(crypto_open());
    }
    Ok(Zeroizing::new(raw))
}

pub fn new_note_key() -> Zeroizing<Vec<u8>> {
    crypto::random_key()
}

/// 造新封套：verify + 一把新 mediaKey（图那边用它包存量）；**不写 contentKey**——新便签一上来就逐张钥匙，无整层钥匙可留。
fn create_envelope(password: &str) -> AppResult<(Envelope, Zeroizing<Vec<u8>>)> {
    crypto::validate_password(password)?;
    let kdf = KdfParams::new_random();
    let master = crypto::derive_key(password, &kdf)?;
    let (v_nonce, v_ct) = crypto::seal(&master, AAD_VERIFY, VERIFY_PLAINTEXT)?;
    let media = crypto::random_key();
    let envelope = Envelope {
        version: ENVELOPE_VERSION,
        kdf,
        verify: SealedBlock {
            nonce: v_nonce,
            ciphertext: v_ct,
        },
        media_key: Some(seal_wrapped(&master, AAD_MEDIA_KEY, &media)?),
        content_key: None,
        data: None,
    };
    Ok((envelope, master))
}

/// 首次设置：新盐 + 新 master，verify 块落盘。master 用完即丢（调用方不保留）
pub fn setup(vault: &PrivateVault, password: &str) -> AppResult<()> {
    // 那份读不出来的还占着位置：立新口令等于把它覆盖掉，而库里那批密文行是从它派生的
    if let Some(error) = vault.damage() {
        return Err(error);
    }
    if vault.is_configured() {
        return Err(AppError::new(
            "ALREADY_CONFIGURED",
            "私密层已经设置过，请直接输入密码",
        ));
    }
    let (envelope, _master) = create_envelope(password)?;
    write_envelope(vault.dir(), &envelope)?;
    vault.mark_configured();
    Ok(())
}

/// 封套是否"整份 map 住在里面"的 v1 形状；是→Some(解开后的 map JSON)。迁移唯一入口，master 由调用方拿着。
pub fn legacy_map(envelope: &Envelope, master: &[u8]) -> AppResult<Option<String>> {
    let Some(block) = envelope.data.as_ref() else {
        return Ok(None);
    };
    if envelope.version != LEGACY_MAP_VERSION {
        return Err(AppError::new(
            "MIGRATE_VERSION",
            format!("v{} 封套里带着 data 块，形状对不上", envelope.version),
        ));
    }
    let bytes = crypto::open(master, AAD_DATA_V1, &block.nonce, &block.ciphertext)?;
    String::from_utf8(bytes).map(Some).map_err(|_| crypto_open())
}

/// 迁移落定：**留底在前**——先拷 v1 留底再写 v2（data 没了）；写失败旧数据还在可重跑，反过来先丢唯一旧 map。
pub fn finish_v1_migration(vault: &PrivateVault) -> AppResult<()> {
    let path = envelope_path(vault.dir());
    let mut envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    if envelope.data.is_none() {
        return Ok(()); // 已经是 v2：什么都不做
    }
    let now = clock::now_ms();
    let keep = vault.dir().join(migrated_file_name(now));
    std::fs::copy(&path, &keep).map_err(|e| {
        AppError::new(
            "PRIVATE_WRITE",
            format!("旧封套留底 {} 没写成：{e}", keep.display()),
        )
    })?;
    envelope.version = ENVELOPE_VERSION;
    envelope.data = None;
    write_envelope(vault.dir(), &envelope)?;
    log::info(
        "private",
        &format!("私密封套迁到 v{ENVELOPE_VERSION}，旧的那份留在 {}", keep.display()),
    );
    Ok(())
}

/// 改密与重置都是**两步**：库里那一拍（重裹键行 / 清空私密内容）+ 换盘上这份封套。
/// 被杀在两步之间就是"封套听旧口令而库里的钥匙听新的"，那种形状谁也解不开。
/// 所以新封套先落在 `private.json.pending` 上待命，而库里那一拍在**同一个事务**里顺手写下
/// `STAGE_MARKER_KEY` 标记——恢复时不需要口令、也不需要解任何东西，只看这两样事实就知道该补哪一步。
pub const PENDING_FILE: &str = "private.json.pending";
pub const STAGE_MARKER_KEY: &str = "private.stage_phase";
/// 库里那一拍已经落定（这条值与那一拍同事务写下去）
pub const MARKER_DB_DONE: &str = "db-done";

pub fn pending_path(dir: &Path) -> PathBuf {
    dir.join(PENDING_FILE)
}

/// 停在 pending 上的新封套
fn stage_envelope(dir: &Path, envelope: &Envelope) -> AppResult<()> {
    let json = serde_json::to_vec_pretty(envelope)
        .map_err(|e| AppError::new("PRIVATE_WRITE", e.to_string()))?;
    write_atomic(dir, &pending_path(dir), &json)
}

/// 库里那一拍成了 → 把 pending 提成 live（rename 同盘原子）
fn promote_pending(dir: &Path) -> AppResult<()> {
    let pending = pending_path(dir);
    if !pending.exists() {
        return Err(AppError::new(
            "PRIVATE_WRITE",
            "留底的那份封套不在了，改密没能收尾".to_string(),
        ));
    }
    std::fs::rename(&pending, envelope_path(dir))
        .map_err(|e| AppError::new("PRIVATE_WRITE", format!("换封套失败：{e}")))?;
    Ok(())
}

fn drop_pending(dir: &Path) {
    let pending = pending_path(dir);
    if pending.exists() {
        let _ = std::fs::remove_file(&pending);
    }
}

/// 启动时对着这两样事实补完那一步。返回的是要落到日志里的一句话（None = 什么都没要补）
pub fn recover_stage(dir: &Path, marker: Option<&str>) -> AppResult<Option<String>> {
    let has_pending = pending_path(dir).exists();
    match (marker, has_pending) {
        (None, false) => Ok(None),
        // 库里那一拍没成（它是一个事务），pending 只是那一步的残骸：丢掉，现场原样
        (None, true) => {
            drop_pending(dir);
            Ok(Some("改密/重置停在半路，库里那一拍没成：留底的封套已丢弃，旧口令照常".to_string()))
        }
        (Some(MARKER_DB_DONE), true) => {
            promote_pending(dir)?;
            Ok(Some(
                "库里那一拍已经落定而封套没换上：启动时补上了这一步（新口令从现在起算数）"
                    .to_string(),
            ))
        }
        // 标记里是一个本程序从没写过的值而留底还在：两份封套都不许动。
        // 这时候 promote 与丢弃各有五成概率把私密内容锁死，猜错一次的代价比留一行的错误大
        (Some(other), true) => Err(AppError::new(
            "PRIVATE_STAGE",
            format!(
                "留底那份封套还在，而库里那一格写着认不得的标记（{other}）：\
                 两份封套都没动，请先弄清这一步走到哪儿了再决定"
            ),
        )),
        // 封套已经换成了，只是标记没来得及清
        (Some(_), false) => Ok(Some("上一步只差清标记：库里那一拍与封套都已落定".to_string())),
    }
}

/// 改密的准备：验旧口令 → 造新封套（旧 mediaKey/contentKey 按新 master 重裹）→ 落到 pending。
/// 交出旧新两把 master 给库里那一拍用。**到这里一个字都还没进库**
pub fn rekey_stage(
    vault: &PrivateVault,
    old_password: &str,
    new_password: &str,
) -> AppResult<(Master, Master)> {
    crypto::validate_password(new_password)?;
    let old_master = master_of(vault, old_password)?;
    let envelope = read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    if envelope.data.is_some() {
        // 还没迁移就先不改密：新封套不带 data 块，这时候把它写没了 = 全部旧正文当场消失
        return Err(AppError::new(
            "MIGRATE_PENDING",
            "旧封套还没迁完，改密要等那一步过去（输口令打开任一张时会自动做）",
        ));
    }
    let (mut next, new_master) = create_envelope(new_password)?;
    // 存量图那把旧 mediaKey：旧 master 开出来、新 master 包回去，图字节一个都不动
    if let Some(block) = envelope.media_key.as_ref() {
        let media = unwrap_wrapped(&old_master, Some(block), AAD_MEDIA_KEY)?
            .ok_or_else(crypto_open)?;
        next.media_key = Some(seal_wrapped(&new_master, AAD_MEDIA_KEY, &media)?);
    }
    // 旧形状那批逐条密文的 contentKey：同理。它们还没搬完的时候改密不该把那些行锁死
    if let Some(block) = envelope.content_key.as_ref() {
        let content = unwrap_wrapped(&old_master, Some(block), AAD_CONTENT_KEY)?
            .ok_or_else(crypto_open)?;
        next.content_key = Some(seal_wrapped(&new_master, AAD_CONTENT_KEY, &content)?);
    }
    stage_envelope(vault.dir(), &next)?;
    Ok((old_master, new_master))
}

/// 改密收尾：库里那一拍（重裹 + 写标记，同一个事务）已经过了 → 换封套
pub fn rekey_finish(vault: &PrivateVault) -> AppResult<()> {
    promote_pending(vault.dir())?;
    vault.mark_configured();
    // 换口令之后原来开着的那几张不再算数：新 master 与旧 master 不是一把
    vault.hide_all();
    Ok(())
}

/// 库里那一拍没成 → 丢掉留底，现场原样（旧口令照常开得开）
pub fn rekey_abort(vault: &PrivateVault) {
    drop_pending(vault.dir());
}

/// 重置的准备：造新封套落到 pending。返回的 master 没人用（新口令下还没有任何一张）
pub fn reset_stage(vault: &PrivateVault, new_password: &str) -> AppResult<()> {
    if !vault.revealed_ids().is_empty() {
        return Err(AppError::new(
            "RESET_WHEN_UNLOCKED",
            "有便签正开着，重置会清空全部私密内容：先收回再改",
        ));
    }
    if !vault.is_configured() && !vault.is_damaged() {
        return Err(AppError::new("PRIVATE_MISSING", "私密层还没有设置"));
    }
    log::warn("private", "私密层重置：旧私密内容全部清除");
    let (envelope, _master) = create_envelope(new_password)?;
    stage_envelope(vault.dir(), &envelope)
}

/// 重置收尾：库里已经清空（同事务写了标记）→ 换新封套上盘
pub fn reset_finish(vault: &PrivateVault) -> AppResult<()> {
    promote_pending(vault.dir())?;
    vault.mark_configured();
    vault.hide_all();
    Ok(())
}

pub fn reset_abort(vault: &PrivateVault) {
    drop_pending(vault.dir());
}

/// 改密走完整趟：`rekey_stage` → `rewrap_and_mark` → `rekey_finish`。
/// `rewrap_and_mark` **必须在自己的一个事务里**同时做完"键行按新 master 重裹"与
/// "settings 写 `MARKER_DB_DONE`"——这两样分开提交，中间被杀就又是那个谁也解不开的形状。
/// 库里那一拍失败就把留底丢掉、现场原样；成功而换封套没成则留着，启动时 `recover_stage` 补完。
pub fn rekey(
    vault: &PrivateVault,
    old_password: &str,
    new_password: &str,
    rewrap_and_mark: impl Fn(&[u8], &[u8]) -> AppResult<usize>,
) -> AppResult<usize> {
    let (old_master, new_master) = rekey_stage(vault, old_password, new_password)?;
    let moved = match rewrap_and_mark(&old_master, &new_master) {
        Ok(moved) => moved,
        Err(e) => {
            rekey_abort(vault);
            return Err(e);
        }
    };
    rekey_finish(vault)?;
    Ok(moved)
}

/// 重置（忘记密码唯一出路）走完整趟：`reset_stage` → `purge_and_mark` → `reset_finish`。
/// `purge_and_mark` 同样是"清空 + 写标记"一个事务。只允许一张都没开着时走。
pub fn reset(
    vault: &PrivateVault,
    new_password: &str,
    purge_and_mark: impl Fn() -> AppResult<usize>,
) -> AppResult<usize> {
    reset_stage(vault, new_password)?;
    let purged = match purge_and_mark() {
        Ok(purged) => purged,
        Err(e) => {
            reset_abort(vault);
            return Err(e);
        }
    };
    reset_finish(vault)?;
    Ok(purged)
}

/// 收回全部（等价于 `hide_all`）。
pub fn lock(vault: &PrivateVault) {
    vault.hide_all();
}

/// 测试用：把封套伪装成 v1（整册 map 住在 `data` 块）。`keep_content_key`：留着 = "迁移断一半"的形状，重跑必须拿到同一把；
/// 抹掉 = 那些行对不上号，正是 `MIGRATE_KEY_MISMATCH` 要拦的。
#[cfg(test)]
pub fn v1_downgrade(
    vault: &PrivateVault,
    master: &[u8],
    map_json: &str,
    keep_content_key: bool,
) -> AppResult<()> {
    let path = envelope_path(vault.dir());
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| AppError::new("PRIVATE_WRITE", format!("读封套失败：{e}")))?;
    let mut value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::new("PRIVATE_WRITE", format!("封套不是合法 JSON：{e}")))?;
    let obj = value
        .as_object_mut()
        .ok_or_else(|| AppError::new("PRIVATE_WRITE", "封套不是对象"))?;
    obj.insert(
        "version".to_string(),
        serde_json::Value::Number(serde_json::Number::from(LEGACY_MAP_VERSION)),
    );
    if !keep_content_key {
        obj.remove("contentKey");
    }
    let (nonce, ciphertext) = crypto::seal(master, AAD_DATA_V1, map_json.as_bytes())?;
    obj.insert(
        "data".to_string(),
        serde_json::json!({ "nonce": nonce, "ciphertext": ciphertext }),
    );
    std::fs::write(&path, value.to_string())
        .map_err(|e| AppError::new("PRIVATE_WRITE", format!("写封套失败：{e}")))?;
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

    const OTHER_NOTE: &str = "另一张没开着的便签";

    #[test]
    fn 设置_验口令_逐张钥匙_改密后照样解得开() {
        let dir = temp_dir("full");
        let vault = PrivateVault::scan(&dir);
        assert!(!vault.is_configured());
        setup(&vault, "口令至少八个字符").expect("设置");
        assert!(vault.is_configured());
        assert!(vault.revealed_ids().is_empty(), "设完口令不等于揭开了哪张");

        let master = master_of(&vault, "口令至少八个字符").expect("master");
        assert_eq!(
            master_of(&vault, "错口令八个字").expect_err("必须失败").code,
            "CRYPTO_OPEN"
        );

        // 一张一把钥匙，且 AAD 绑住那张：拿 X 的密文钥匙去解 Y 的，解不开
        let key_x = new_note_key();
        let packed = seal_note_key(&master, "X", &key_x).expect("包");
        assert_eq!(
            open_note_key(&master, "X", &packed).expect("解").as_slice(),
            key_x.as_slice()
        );
        assert_eq!(
            open_note_key(&master, OTHER_NOTE, &packed)
                .expect_err("换一张就解不开")
                .code,
            "CRYPTO_OPEN"
        );

        // 改密：新旧两把 master 交给 rewrap（键行按新 master 重裹），内容字节一个都不动
        let seen = std::cell::RefCell::new(Vec::<(Vec<u8>, Vec<u8>)>::new());
        let moved = rekey(&vault, "口令至少八个字符", "换个长一点的口令", |from, to| {
            seen.borrow_mut().push((from.to_vec(), to.to_vec()));
            Ok(3)
        })
        .expect("改密");
        assert_eq!(moved, 3, "重裹了几条由 rewrap 报，命令层拿它写日志");
        let calls = seen.borrow();
        assert_eq!(calls.len(), 1, "一次改密重裹一遍");
        assert_eq!(calls[0].0, master.as_slice().to_vec(), "进来的是旧 master");
        let new_master = master_of(&vault, "换个长一点的口令").expect("新口令验 master");
        assert_eq!(calls[0].1, new_master.as_slice().to_vec(), "第二个是新 master");
        assert_ne!(master.as_slice(), new_master.as_slice());
        assert!(
            open_note_key(&new_master, "X", &packed).is_err(),
            "旧包在新 master 下解不开——rewrap_keys 因此是必须的"
        );
        let rewrapped = seal_note_key(&new_master, "X", &key_x).expect("重裹");
        assert_eq!(
            open_note_key(&new_master, "X", &rewrapped).expect("解").as_slice(),
            key_x.as_slice(),
            "重裹之后那张的钥匙还是同一把：内容字节不必动"
        );
        assert!(master_of(&vault, "口令至少八个字符").is_err(), "旧口令作废");
        drop(calls);
    }

    /// 库里那一拍失败：留底丢掉，封套与钥匙都还是旧的——旧口令照常开得开（不存在"改了一半"）
    #[test]
    fn 库里那一拍失败时留底被丢掉() {
        let dir = temp_dir("rekey-db-fails");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let before = std::fs::read_to_string(envelope_path(&dir)).expect("读");
        let err = rekey(&vault, "口令至少八个字符", "换个长一点的口令", |_, _| {
            Err(AppError::new("DB_SQL", "模拟库里写不动"))
        })
        .expect_err("必须报错");
        assert_eq!(err.code, "DB_SQL");
        assert_eq!(
            std::fs::read_to_string(envelope_path(&dir)).expect("再读"),
            before,
            "封套停在旧的那份"
        );
        assert!(
            !pending_path(&dir).exists(),
            "留底不许留下：库里那一拍没成，它只是一具残骸"
        );
        assert!(master_of(&vault, "口令至少八个字符").is_ok(), "旧口令照常");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 被杀在"库里那一拍已成、封套还没换"那一格：启动只看标记 + 留底两样事实就把这一步补完
    #[test]
    fn 半路被杀_启动补完换封套() {
        let dir = temp_dir("rekey-crash");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let (old, new) = rekey_stage(&vault, "口令至少八个字符", "换个长一点的口令").expect("留底");
        assert!(old.len() == new.len() && old.as_slice() != new.as_slice());
        assert!(pending_path(&dir).exists(), "新封套待在留底位上");
        assert!(master_of(&vault, "口令至少八个字符").is_ok(), "此刻还是旧口令的世界");

        // 库里那一拍成了（真机上是"重裹 + 写标记"一个事务），然后断电
        let note = recover_stage(&dir, Some(MARKER_DB_DONE))
            .expect("补完")
            .expect("该有一句话");
        assert!(note.contains("补上了"), "{note}");
        assert!(!pending_path(&dir).exists(), "提成 live 之后留底不该还在");
        let after = PrivateVault::scan(&dir);
        assert!(master_of(&after, "换个长一点的口令").is_ok(), "新口令现在算数");
        assert!(master_of(&after, "口令至少八个字符").is_err(), "旧口令作废");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 另外两种"半路"的形状：只有留底（那一拍没成 → 丢掉）、只有标记（换完了没清标记 → 什么都不用动）
    #[test]
    fn 留底与标记的其它两种组合() {
        let dir = temp_dir("stage-combos");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let good = std::fs::read_to_string(envelope_path(&dir)).expect("读");

        rekey_stage(&vault, "口令至少八个字符", "换个长一点的口令").expect("留底");
        let note = recover_stage(&dir, None).expect("补完").expect("该有一句话");
        assert!(note.contains("丢弃"), "{note}");
        assert!(!pending_path(&dir).exists());
        assert_eq!(
            std::fs::read_to_string(envelope_path(&dir)).expect("再读"),
            good,
            "现场一字没动"
        );
        assert!(master_of(&vault, "口令至少八个字符").is_ok());

        // 封套已经换成了、只剩标记没清：这次连文件都不许碰
        let note = recover_stage(&dir, Some(MARKER_DB_DONE))
            .expect("补完")
            .expect("该有一句话");
        assert!(note.contains("都已落定"), "{note}");
        assert_eq!(
            std::fs::read_to_string(envelope_path(&dir)).expect("再读"),
            good,
            "没有留底可提，封套原样"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 揭开是按张的_收回是一起收() {
        let dir = temp_dir("reveal");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let master = master_of(&vault, "口令至少八个字符").expect("master");
        let kx = new_note_key();
        let ky = new_note_key();
        vault.reveal("X", kx.clone());
        assert!(vault.is_revealed("X"));
        assert!(!vault.is_revealed("Y"), "开一张不会把别的张一起开");
        assert_eq!(vault.revealed_ids(), vec!["X".to_string()]);
        assert!(
            vault.revealed_key("Y").is_none(),
            "没揭开的张拿不到钥匙"
        );
        vault.reveal("Y", ky.clone());
        assert_eq!(vault.revealed_ids().len(), 2);
        assert_eq!(vault.revealed_key("X").expect("有").as_slice(), kx.as_slice());
        lock(&vault);
        assert!(vault.revealed_ids().is_empty(), "收回时全清");
        assert_eq!(
            vault.revealed_key("X").map(|k| k.as_slice().to_vec()),
            None::<Vec<u8>>,
            // 上锁之后连钥匙都不该在内存里
        );
        let _ = master;
    }

    #[test]
    fn 损坏封套按未配置算_文件不删() {
        let dir = temp_dir("corrupt");
        std::fs::write(envelope_path(&dir), "不是封套").expect("写坏文件");
        let vault = PrivateVault::scan(&dir);
        assert!(!vault.is_configured());
        assert!(vault.is_damaged(), "但要知道那是坏了、不是没有");
        assert!(envelope_path(&dir).exists(), "现场不删");
    }

    /// 坏封套不是"没配置"：立新口令等于把唯一那份材料覆盖掉，只留重置这一条出路
    #[test]
    fn 坏封套时设置被拒_重置是唯一出路() {
        let dir = temp_dir("damaged");
        std::fs::write(envelope_path(&dir), "不是封套").expect("写坏文件");
        let vault = PrivateVault::scan(&dir);
        let err = setup(&vault, "口令至少八个字符")
            .expect_err("不许覆盖那份读不出来的")
            .code;
        assert_eq!(err, "PRIVATE_DAMAGED");
        assert!(envelope_path(&dir).exists(), "被拒这一次也不动现场");
        reset(&vault, "重置后使用的新口令", || Ok(0)).expect("重置是出路");
        assert!(!vault.is_damaged() && vault.is_configured(), "写进去的新那份就是当前真相");
        assert!(master_of(&vault, "重置后使用的新口令").is_ok());
    }

    #[test]
    fn 不认识的封套版本直接拒() {
        let dir = temp_dir("version");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let good = std::fs::read_to_string(envelope_path(&dir)).expect("读");
        for bad in [3u32, 0, 99] {
            let mut value: serde_json::Value = serde_json::from_str(&good).expect("JSON");
            value["version"] = serde_json::Value::Number(serde_json::Number::from(bad));
            std::fs::write(envelope_path(&dir), value.to_string()).expect("写坏版本");
            let message = read_envelope(&dir).expect_err("必须拒").to_string();
            assert!(message.contains("只认 v2"), "说清认哪个版本：{message}");
            assert!(
                master_of(&vault, "口令至少八个字符").is_err(),
                "坏版本连 master 都拿不到（v{bad}）"
            );
            assert!(
                !PrivateVault::scan(&dir).is_configured(),
                "重启扫一次也会把坏版本当成没配置"
            );
        }
        std::fs::write(envelope_path(&dir), good).expect("还原");
        assert!(master_of(&vault, "口令至少八个字符").is_ok());
        assert!(PrivateVault::scan(&dir).is_configured());
    }

    #[test]
    fn 原子写不留临时文件() {
        let dir = temp_dir("atomic");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        assert!(envelope_path(&dir).exists());
        assert!(!dir.join(".private.json.tmp").exists(), "tmp 已改名");
    }

    #[test]
    fn 未解锁是重置的合法前提() {
        let dir = temp_dir("reset");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        vault.reveal("X", new_note_key());
        assert_eq!(
            reset(&vault, "重置后使用的新口令", || Ok(0))
                .expect_err("开着就不许重置")
                .code,
            "RESET_WHEN_UNLOCKED"
        );
        lock(&vault);
        reset(&vault, "重置后使用的新口令", || Ok(0)).expect("都收回之后重置合法");
    }

    /// 新封套不再写 contentKey：整层正文钥匙这个概念已经拆掉了
    #[test]
    fn 新封套只有验证材料与图那把旧钥匙() {
        let dir = temp_dir("fresh");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let envelope = read_envelope(&dir).expect("读").expect("有");
        assert_eq!(envelope.version, ENVELOPE_VERSION);
        assert!(envelope.data.is_none(), "正文不住在这个文件里");
        assert!(envelope.content_key.is_none(), "不再造整层正文钥匙");
        assert!(envelope.media_key.is_some(), "存量图还要靠它重裹");
    }

    #[test]
    fn 旧封套没迁完时拒绝改密() {
        let dir = temp_dir("rekey-pending");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let master = master_of(&vault, "口令至少八个字符").expect("master");
        v1_downgrade(&vault, &master, r#"{"s1":{"title":"旧封套里的真身"}}"#, false)
            .expect("伪装成 v1");
        let err = rekey(&vault, "口令至少八个字符", "换个口令八字以上", |_, _| Ok(0))
            .expect_err("必须拒");
        assert_eq!(err.code, "MIGRATE_PENDING");
        let still = read_envelope(&dir).expect("读").expect("有");
        assert!(still.data.is_some(), "被拒这一次不许动旧封套");
    }

    #[test]
    fn 迁移落定改写封套并留底() {
        let dir = temp_dir("migrate-finish");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let master = master_of(&vault, "口令至少八个字符").expect("master");
        v1_downgrade(&vault, &master, r#"{"s1":{"title":"旧封套里的真身"}}"#, false)
            .expect("伪装成 v1");
        let envelope = read_envelope(&dir).expect("读").expect("有");
        assert_eq!(
            legacy_map(&envelope, &master)
                .expect("读")
                .expect("有")
                .trim(),
            r#"{"s1":{"title":"旧封套里的真身"}}"#
        );
        finish_v1_migration(&vault).expect("落定");

        let after = read_envelope(&dir).expect("读").expect("有");
        assert_eq!(after.version, ENVELOPE_VERSION);
        assert!(after.data.is_none(), "data 块没了");
        let kept = std::fs::read_dir(&dir)
            .expect("列目录")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("private.json.migrated-"))
            })
            .expect("留底文件在");
        let kept_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&kept).expect("读留底"))
                .expect("留底是合法 JSON");
        assert_eq!(kept_json["version"].as_i64(), Some(1), "留底是 v1");
        assert!(kept_json.get("data").is_some(), "留底还带着那个旧 map 块");
        finish_v1_migration(&vault).expect("重跑");
        assert!(
            read_envelope(&dir).expect("读").expect("有").data.is_none(),
            "重跑不再动封套"
        );
    }

    /// 断点重跑用的那份"v1 + 已补 contentKey"形状：留着钥匙，重跑时不该再造第二把
    #[test]
    fn 留着旧钥匙的重跑形状读得懂() {
        let dir = temp_dir("migrate-rerun");
        let vault = PrivateVault::scan(&dir);
        setup(&vault, "口令至少八个字符").expect("设置");
        let master = master_of(&vault, "口令至少八个字符").expect("master");
        let legacy = legacy_content_key(
            &read_envelope(&dir).expect("读").expect("有"),
            &master,
        )
        .expect("问一次");
        assert!(legacy.is_none(), "新封套本来就没有 contentKey");
        // 手工造一份"带着 contentKey 的 v1"（上一次迁移跑到一半断了的形状）
        let content = crypto::random_key();
        let mut envelope = read_envelope(&dir).expect("读").expect("有");
        envelope.content_key = Some(seal_wrapped(&master, AAD_CONTENT_KEY, &content).expect("包"));
        envelope.data = Some(seal_wrapped(&master, AAD_DATA_V1, b"{}").expect("包"));
        envelope.version = LEGACY_MAP_VERSION;
        write_envelope(vault.dir(), &envelope).expect("写");
        let back = read_envelope(&dir).expect("读").expect("有");
        assert_eq!(
            legacy_content_key(&back, &master)
                .expect("解")
                .expect("有")
                .as_slice(),
            content.as_slice(),
            "旧钥匙原样解得回来"
        );
        assert_eq!(
            legacy_media_key(&back, &master).expect("解").expect("有").len(),
            crypto::KEY_LEN
        );
    }

    #[test]
    fn aad_按行按版与按张绑定() {
        assert_eq!(media_aad("a1"), [AAD_MEDIA, &b"a1"[..]].concat());
        assert_ne!(media_aad("a1"), media_aad("a2"), "换一行就是另一套 AAD");
        assert_eq!(content_aad("s1"), [AAD_CONTENT, &b"s1"[..]].concat());
        assert_ne!(revision_aad("s1", 3), revision_aad("s1", 4), "换 seq 也是另一套");
        assert_ne!(revision_aad("s1", 3), content_aad("s1"), "正文与它的版本互不通用");
        assert_eq!(note_key_aad("s1"), [AAD_NOTE_KEY, &b"s1"[..]].concat());
        assert_ne!(note_key_aad("s1"), content_aad("s1"), "钥匙与内容互不通用");
    }
}
