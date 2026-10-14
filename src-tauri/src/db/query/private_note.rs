// private_note — 私密正文的逐条密文：一张一条、历史一版一条、**一张一把钥匙**。
// 私密层唯一的"内容 ↔ 密文"转换点，也是唯一决定"这一行抹不抹成占位"的地方。钥匙判据是
// **这张有没有键行**：有 = 正文/历史/图都在自己的钥匙下；没有 = 还停在旧整层钥匙，等第一次
// `reveal` 当场搬（一个事务）。不一次全搬——全搬要握着一把能开整层的钥匙，正是这版要拆的东西。
// 四条口径：没配置 = 明文直通；没揭开的读不出但删得掉（删不需要密钥）；占位写不许覆盖真身，
// 带真身没揭开抛 PRIVATE_LOCKED；一次口令只开一张。历史阈值唯一在 `revision.rs`。
// 收 `&Connection` 的调用点都已拿着 `Db` 那把不可重入的锁；只有 `reveal` 自己开事务、还要读写封套文件。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::revision::{self, COALESCE_MS, DAY_MS, KEEP_DAYS, KEEP_PER_NOTE};
use crate::data::crypto;
use crate::data::private::{self, PrivateVault};
use crate::db::models::{StickyInput, StickyItem, StickyRow, TimelineEntry};
use crate::support::error::{AppError, AppResult};
use crate::support::log;

/// 抹成占位时那几列写什么。六个字段里 `content_type` 不占位：类型决定这扇窗用什么形状
/// 去蒙（清单/时间轴/文本），蒙版也得有个形状。
const BLANK_JSON: &str = "[]";

/// 私密便签住进表里的那六个字段。三份 `*_json` 存的是与列上同一次序列化出来的字符串
/// （同 `revision::Content` 的理由：回滚与"有没有变过"的比较都按原样串，键序不漂）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SealedContent {
    pub title: String,
    pub body: String,
    pub content_type: String,
    pub items_json: String,
    pub timeline_json: String,
    pub tags_json: String,
}

impl SealedContent {
    /// 从一次写入的输入抽出来。三份 JSON 串由调用方给（`sticky::upsert` 刚序列化过，
    /// 不复用就得再序列化一遍，两次的键序理论上可以不同）
    pub fn from_input(
        input: &StickyInput,
        items_json: &str,
        timeline_json: &str,
        tags_json: &str,
    ) -> Self {
        Self {
            title: input.title.clone(),
            body: input.body.clone(),
            content_type: input.content_type.clone(),
            items_json: items_json.to_string(),
            timeline_json: timeline_json.to_string(),
            tags_json: tags_json.to_string(),
        }
    }

    /// 这一份是不是"没写字"。占位判断只看这一行有没有字，与表里有没有条目无关
    pub fn is_blank(&self) -> bool {
        self.title.is_empty()
            && self.body.is_empty()
            && self.items_json == BLANK_JSON
            && self.timeline_json == BLANK_JSON
            && self.tags_json == BLANK_JSON
    }

    /// 封这一张。AAD 绑在 id 上：换一张便签就换一套 AAD，换一把钥匙更是解不开
    pub fn seal(&self, key: &[u8], id: &str) -> AppResult<Vec<u8>> {
        let raw = serde_json::to_vec(self).map_err(|e| {
            AppError::new("PRIVATE_DATA", format!("私密内容序列化失败：{e}"))
        })?;
        crypto::seal_blob(key, &private::content_aad(id), &raw)
    }

    /// 解这一张。解不开一律"口令不正确或数据已损坏"那一口径（crypto.rs 不变量 4）
    pub fn open(key: &[u8], id: &str, packed: &[u8]) -> AppResult<Self> {
        let raw = crypto::open_blob(key, &private::content_aad(id), packed)?;
        serde_json::from_slice(&raw).map_err(|_| open_failed())
    }
}

/// 某一版：AAD 里带 seq，同一条密文挪个 seq 就解不开
fn seal_revision(key: &[u8], id: &str, seq: i64, content: &SealedContent) -> AppResult<Vec<u8>> {
    let raw = serde_json::to_vec(content)
        .map_err(|e| AppError::new("PRIVATE_DATA", format!("私密版本序列化失败：{e}")))?;
    crypto::seal_blob(key, &private::revision_aad(id, seq), &raw)
}

fn open_revision(key: &[u8], id: &str, seq: i64, packed: &[u8]) -> AppResult<SealedContent> {
    let raw = crypto::open_blob(key, &private::revision_aad(id, seq), packed)?;
    serde_json::from_slice(&raw).map_err(|_| open_failed())
}

fn open_failed() -> AppError {
    AppError::new("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）")
}

/// "这一张没揭开"那一口径。文案按调用场景分两条，错码必须是同一个：
/// 前端 `notes-store` 靠 `PRIVATE_LOCKED` 决定"改动留在在途里、别再空转重试"
fn not_revealed(reading: bool) -> AppError {
    AppError::new(
        "PRIVATE_LOCKED",
        if reading {
            "这张便签还没揭开：输入口令才读得出它的真身"
        } else {
            "这张便签还没揭开：改动留在在途里，等揭开之后落库"
        },
    )
}

/// 揭开着的那一张的钥匙。**只有**这一格能拿到钥匙——没有任何"整层钥匙"可取
fn own_key(vault: &PrivateVault, id: &str, reading: bool) -> AppResult<Zeroizing<Vec<u8>>> {
    vault.revealed_key(id).ok_or_else(|| not_revealed(reading))
}

/// 这一拍 `stickies` 行该怎么写、表里那几条该怎么动。判据全在这里，别处不再判第二次。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    /// 直通：行按 input 原样写，表不碰（私密层没启用，或这张不私密且表里干净）
    Plain,
    /// 真身进表（并记一版），行上那六个字段抹成占位
    Seal,
    /// 行写占位，表里那一条**原样留着**：这张没揭开，或这一拍手上本来就没字
    Placeholders,
    /// 这张翻回公开了：行按 input 写、表里那两条与键行删掉。`restore = true` 表示 input
    /// 没带字而表里有真身，那份得回进行里（空壳不算"翻回公开"）
    Publish,
    /// 拒绝这一拍。错码与文案都是写死的这两组，别处不许再造
    Refuse(Refused),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// 没揭开，却递上来一份带字的私密便签
    EditingLocked,
    /// 没揭开，却要把一张"表里有真身"的便签翻成公开
    PublishingLocked,
}

impl Refused {
    pub fn error(self) -> AppError {
        match self {
            Refused::EditingLocked => AppError::new(
                "PRIVATE_LOCKED",
                "这张便签还没揭开：这一拍的改动留在在途里，等揭开之后落库",
            ),
            Refused::PublishingLocked => AppError::new(
                "PRIVATE_LOCKED",
                "这张便签还没揭开：真身读不出来，不能翻成公开",
            ),
        }
    }
}

/// 定这一拍的形状。`content` 是从这一拍 input 那六个字段抽出来的（要封的就是它）。
///
/// 问的是**这一张**揭没揭开（`vault.is_revealed(id)`），不是"整层开没开"——
/// 一屏十二扇窗里可以只有两扇是真身，其余照旧蒙着。
pub fn plan(
    conn: &Connection,
    vault: &PrivateVault,
    id: &str,
    input_private: bool,
    content: &SealedContent,
) -> AppResult<Plan> {
    // 封套读不出来时，"没配置"这个判断不成立：这一拍要写私密、或这张本来就有密文行，
    // 就停手。当没配置写明文直过去，等于让行上那句 private=1 与那条解不开的密文分家，
    // 而界面上看着一切正常——那是最不容易被发现的一种坏法
    if let Some(error) = vault.damage() && (input_private || exists(conn, id)?) {
        return Err(error);
    }
    // 没配置 = 私密层根本不存在这回事，"私密"只是个标记（口径同 commands/media.rs）
    if !vault.is_configured() {
        return Ok(Plan::Plain);
    }
    let sealed_exists = exists(conn, id)?;
    let has_plain = !content.is_blank();
    let open = vault.is_revealed(id);

    if input_private {
        return Ok(match (open, has_plain, sealed_exists) {
            // 没揭开还带着真身：写占位等于删掉那几个字，而这一张此刻没有密钥可写。抛回去
            (false, true, _) => Plan::Refuse(Refused::EditingLocked),
            // 没揭开、手上就是占位（翻置顶、挪窗那些动作）：照占位写库，不碰表
            (false, false, _) => Plan::Placeholders,
            // 揭开着但这一拍没带字，而表里已经有真身：那是只改了摆位/颜色的一拍，
            // 拿空去覆盖真身就是丢内容
            (true, false, true) => Plan::Placeholders,
            // 揭开着且带着字 → 封
            (true, true, _) => Plan::Seal,
            // 揭开着、没带字、表里也没东西（新建的一张空私密签）：占位即可，
            // 不必为"空"造一条密文行
            (true, false, false) => Plan::Placeholders,
        });
    }

    // 这一拍是公开便签
    if !sealed_exists {
        return Ok(Plan::Plain);
    }
    if !open {
        return Ok(Plan::Refuse(Refused::PublishingLocked));
    }
    // 表里那一条要摘掉；至于行上写什么（input 那份字，还是表里那份真身）由 `write` 定，
    // 它本来就要读那一条
    Ok(Plan::Publish)
}

/// 表里有没有这一张的那条密文。不揭开也问得出来（只看行在不在）
pub fn exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM private_content WHERE note_id = ?1",
            [id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// 解开这一张的真身。表里没这一张 → None。没揭开 → PRIVATE_LOCKED
pub fn load(conn: &Connection, vault: &PrivateVault, id: &str) -> AppResult<Option<SealedContent>> {
    let key = own_key(vault, id, true)?;
    let Some(packed) = current_packed(conn, id)? else {
        return Ok(None);
    };
    Ok(Some(SealedContent::open(&key, id, &packed)?))
}

/// 这一拍要把行写成占位还是原样，连同表里的动作一起做掉。
/// 返回 `(该行进 stickies 的五个字段, 这一拍已经封进去的那份真身)`——
/// 后一个是 `Some` 时调用方**不必**再把那一行解密回来合并（手里就是）。
pub fn write(
    conn: &Connection,
    vault: &PrivateVault,
    plan: Plan,
    content: &SealedContent,
    input: &StickyInput,
    now: i64,
    force_revision: bool,
) -> AppResult<(RowFields, Option<SealedContent>)> {
    match plan {
        // 直通：行上写 input 自己那一份，读回来的就是它
        Plan::Plain => Ok((RowFields::from(content), None)),
        Plan::Refuse(reason) => Err(reason.error()),
        // 表里那一条一个字都不动，行写占位 → 读回来时还得把表里那份解回去
        Plan::Placeholders => Ok((RowFields::blank(), None)),
        Plan::Seal => {
            save(conn, vault, &input.id, content, now, force_revision)?;
            Ok((RowFields::blank(), Some(content.clone())))
        }
        Plan::Publish => {
            // input 没带字而表里有真身 → 把那份搬回行上，别把空壳公布出去；
            // 两种都要摘掉表里那两条与键行（留着就是解不开的孤儿）
            let restore = if content.is_blank() {
                load(conn, vault, &input.id)?
            } else {
                None
            };
            delete_for_note(conn, &input.id)?;
            Ok(match restore {
                Some(sealed) => (RowFields::from(&sealed), None),
                None => (RowFields::from(content), None),
            })
        }
    }
}

/// 进 `stickies` 那六列的值（`content_type` 不在内：它不占位）。
/// 抽成一个小结构，免得调用方去猜"占位到底是哪几个空"
pub struct RowFields {
    pub title: String,
    pub body: String,
    pub items_json: String,
    pub timeline_json: String,
    pub tags_json: String,
}

impl RowFields {
    fn from(content: &SealedContent) -> Self {
        Self {
            title: content.title.clone(),
            body: content.body.clone(),
            items_json: content.items_json.clone(),
            timeline_json: content.timeline_json.clone(),
            tags_json: content.tags_json.clone(),
        }
    }

    fn blank() -> Self {
        Self {
            title: String::new(),
            body: String::new(),
            items_json: BLANK_JSON.to_string(),
            timeline_json: BLANK_JSON.to_string(),
            tags_json: BLANK_JSON.to_string(),
        }
    }
}

/// 写一张的真身：先把**被换掉之前**那一版记进 private_revision，再整行覆盖。
/// 一版记不上不该挡住这次写（同 `sticky::upsert` 那句理由），所以降成一条日志。
pub fn save(
    conn: &Connection,
    vault: &PrivateVault,
    id: &str,
    content: &SealedContent,
    now: i64,
    force_revision: bool,
) -> AppResult<()> {
    let key = own_key(vault, id, false)?;
    if let Some(packed) = current_packed(conn, id)? {
        let before = SealedContent::open(&key, id, &packed)?;
        // 空壳不配留成一版
        if !before.is_blank()
            && let Err(e) = record_revision(conn, &key, id, &before, now, force_revision)
        {
            log::warn("private", &format!("记私密历史版本失败（这次写照走）：{e}"));
        }
    }
    put(conn, id, &content.seal(&key, id)?, now)?;
    Ok(())
}

fn current_packed(conn: &Connection, id: &str) -> AppResult<Option<Vec<u8>>> {
    conn.query_row(
        "SELECT content FROM private_content WHERE note_id = ?1",
        [id],
        |row| row.get::<_, Vec<u8>>(0),
    )
    .optional()
    .map_err(AppError::from)
}

/// 覆盖那一行的密文。`tx` 也收 `&Connection`，所以迁移与收编都复用这一格
fn put(conn: &Connection, id: &str, packed: &[u8], now: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO private_content (note_id, content, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(note_id) DO UPDATE SET content = ?2, updated_at = ?3",
        params![id, packed, now],
    )?;
    Ok(())
}

/// 被换掉之前那一版进历史。判据与 `revision::record` 同一条：没变不占格、
/// 冷却内不占格、两头夹保留量。`force` 只给回滚用
fn record_revision(
    conn: &Connection,
    key: &[u8],
    id: &str,
    before: &SealedContent,
    now: i64,
    force: bool,
) -> AppResult<()> {
    let last: Option<(i64, i64, Vec<u8>)> = conn
        .query_row(
            "SELECT seq, created_at, content FROM private_revision \
             WHERE note_id = ?1 ORDER BY seq DESC LIMIT 1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let mut next_seq = 1;
    if let Some((seq, created_at, packed)) = &last {
        // 内容没变（比如只是拖动了一下窗、翻了个置顶）不配占格。
        // 注意解它要走 `open_revision`（AAD 带 seq），拿正文那一套 AAD 去解是解不开的
        if &open_revision(key, id, *seq, packed)? == before {
            return Ok(());
        }
        if !force && now - created_at < COALESCE_MS {
            return Ok(());
        }
        next_seq = seq + 1;
    }
    conn.execute(
        "INSERT INTO private_revision (note_id, seq, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, next_seq, seal_revision(key, id, next_seq, before)?, now],
    )?;
    prune_revisions(conn, id, now)?;
    Ok(())
}

/// 一张的保留量：先按天清，再按条数清到最新 50。两条 DELETE 都只用明文列
fn prune_revisions(conn: &Connection, id: &str, now: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM private_revision WHERE note_id = ?1 AND created_at < ?2",
        params![id, now - KEEP_DAYS * DAY_MS],
    )?;
    conn.execute(
        "DELETE FROM private_revision WHERE note_id = ?1 AND seq NOT IN \
         (SELECT seq FROM private_revision WHERE note_id = ?1 ORDER BY seq DESC LIMIT ?2)",
        params![id, KEEP_PER_NOTE],
    )?;
    Ok(())
}

/// 删掉这一张的全部私密内容（正文 + 历史 + 键行）。**不需要密钥**，所以锁着也删得动。
/// 键行必须一起走：那张都不在了，留着包着钥匙的那 32 字节就是纯孤儿
pub fn delete_for_note(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM private_content WHERE note_id = ?1", [id])?;
    conn.execute("DELETE FROM private_revision WHERE note_id = ?1", [id])?;
    conn.execute("DELETE FROM private_keys WHERE note_id = ?1", [id])?;
    Ok(())
}

/// 便签行没了而密文/键行还留着的那些（绕过包装层硬删漏下的、快照恢复留下的）。
///
/// `keep` 是**此刻正揭着**的那几张：新便签标私密时前端先要口令（当场建键行），那次写还要
/// 过 250ms 去抖才落库——中间这一拍它的行确实还不存在。把它们算孤儿删掉，落库封进去的
/// 正文就再也没有钥匙对得上（那是永久解不开，不是"暂时读不到"）。
pub fn reap_orphans(conn: &Connection, keep: &[String]) -> AppResult<usize> {
    let content = conn.execute(
        "DELETE FROM private_content WHERE note_id NOT IN (SELECT id FROM stickies)",
        [],
    )?;
    let revisions = conn.execute(
        "DELETE FROM private_revision WHERE note_id NOT IN (SELECT id FROM stickies)",
        [],
    )?;
    let mut stmt = conn.prepare(
        "SELECT note_id FROM private_keys WHERE note_id NOT IN (SELECT id FROM stickies)",
    )?;
    let orphans = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut keys = 0usize;
    for id in orphans.iter().filter(|id| !keep.contains(id)) {
        keys += conn.execute("DELETE FROM private_keys WHERE note_id = ?1", [id])?;
    }
    Ok(content + revisions + keys)
}

/// 重置（忘记密码）之后：master 换了一把，旧键行、旧逐条密文、旧版本行统统再也解不开，
/// 整批清掉。与"重置清空全部私密内容"同一条口径（图片那侧见 `db::query::media::purge_encrypted_conn`）
pub fn purge_all(conn: &Connection) -> AppResult<usize> {
    let content = conn.execute("DELETE FROM private_content", [])?;
    let revisions = conn.execute("DELETE FROM private_revision", [])?;
    let keys = conn.execute("DELETE FROM private_keys", [])?;
    Ok(content + revisions + keys)
}

/// 把解出来的五个字段盖回一行。`content_type` 用行上那份（类型不占位，见 BLANK 那段）。
/// 也给写路径用：刚封进去的那一份手里就有，不必再解密一遍。
pub fn apply(row: &mut StickyRow, content: &SealedContent) {
    row.title = content.title.clone();
    row.body = content.body.clone();
    // 与 `row_to_sticky` 同一条容忍：脏 JSON 当空，不许因为一处坏值把整行读失败
    row.items = serde_json::from_str::<Vec<StickyItem>>(&content.items_json).unwrap_or_default();
    row.timeline =
        serde_json::from_str::<Vec<TimelineEntry>>(&content.timeline_json).unwrap_or_default();
    row.tags = serde_json::from_str::<Vec<String>>(&content.tags_json).unwrap_or_default();
}

/// 读路径的合并：**只并揭开的那几张**，每张用它自己的钥匙。
/// 没配置或这一张没揭开 → 原样不动（那就是占位）。某一张解不开只拖垮它自己那一行，
/// 其余照旧合并——同"坏行被丢弃但不拖垮整屏"那条口径。
pub fn merge(conn: &Connection, vault: &PrivateVault, rows: &mut [StickyRow]) -> AppResult<()> {
    if !vault.is_configured() {
        return Ok(());
    }
    // 一张都没开就没有后面那发 SELECT：桌面常态正是"全部蒙着"
    let open: Vec<String> = rows
        .iter()
        .filter(|row| row.is_private && vault.is_revealed(&row.id))
        .map(|row| row.id.clone())
        .collect();
    if open.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT note_id, content FROM private_content WHERE note_id IN ({})",
        open
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(","),
    ))?;
    let found = stmt.query_map(rusqlite::params_from_iter(open.iter()), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    let mut opened: std::collections::HashMap<String, SealedContent> =
        std::collections::HashMap::new();
    for row in found {
        let (id, packed) = row?;
        let key = own_key(vault, &id, true)?;
        match SealedContent::open(&key, &id, &packed) {
            Ok(content) => {
                opened.insert(id, content);
            }
            Err(e) => log::warn("private", &format!("私密便签 {id} 的真身解不开（按占位显示）：{e}")),
        }
    }
    for row in rows.iter_mut().filter(|row| row.is_private) {
        if let Some(content) = opened.get(&row.id) {
            apply(row, content);
        }
    }
    Ok(())
}

/// 单行合并（`sticky::get` 那条路）
pub fn merge_one(conn: &Connection, vault: &PrivateVault, row: &mut StickyRow) -> AppResult<()> {
    if !row.is_private {
        return Ok(());
    }
    merge(conn, vault, std::slice::from_mut(row))
}

/// 图片那一侧要的钥匙：这一张的（图跟正文同一条钥匙，见 0012 头部）。
/// 命令层（`commands/media.rs`）只问这一格，不许自己去碰封套
pub fn image_key(vault: &PrivateVault, note_id: &str) -> AppResult<Zeroizing<Vec<u8>>> {
    own_key(vault, note_id, true)
}

/// 私密便签的版本列表（新的在前）。没揭开由 `own_key` 抛 PRIVATE_LOCKED ——
/// 那正是"必须输密码才能看历史"落的地方：私密的版本与私密的正文共用同一道门
pub fn revision_list(
    conn: &Connection,
    vault: &PrivateVault,
    id: &str,
) -> AppResult<Vec<revision::RevisionMeta>> {
    let key = own_key(vault, id, true)?;
    let mut stmt = conn.prepare(
        "SELECT seq, created_at, content FROM private_revision \
         WHERE note_id = ?1 ORDER BY seq DESC",
    )?;
    let rows = stmt.query_map([id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (seq, created_at, packed) = row?;
        let content = open_revision(&key, id, seq, &packed)?;
        out.push(revision::RevisionMeta {
            preview: revision::preview_of_parts(
                &content.content_type,
                &content.body,
                &content.items_json,
                &content.timeline_json,
            ),
            title: content.title.clone(),
            content_type: content.content_type.clone(),
            seq,
            created_at,
        });
    }
    Ok(out)
}

/// 回滚到某一版：只动表里那一条（行上是占位，没有内容可换）。
/// 回滚前先把**当前这份**强记成一版（`force` 绕过冷却——刚打的字立刻回滚，
/// 不记就没有回头路）。返回那一版的内容，调用方拿它去更新视图。
pub fn revert(
    conn: &Connection,
    vault: &PrivateVault,
    id: &str,
    seq: i64,
    now: i64,
) -> AppResult<SealedContent> {
    let key = own_key(vault, id, false)?;
    let target_packed: Option<Vec<u8>> = conn
        .query_row(
            "SELECT content FROM private_revision WHERE note_id = ?1 AND seq = ?2",
            params![id, seq],
            |row| row.get(0),
        )
        .optional()?;
    let target_packed = target_packed
        .ok_or_else(|| AppError::new("REVISION_MISSING", format!("私密便签没有第 {seq} 版")))?;
    let target = open_revision(&key, id, seq, &target_packed)?;
    if let Some(current_packed) = current_packed(conn, id)? {
        let current = SealedContent::open(&key, id, &current_packed)?;
        if !current.is_blank() {
            record_revision(conn, &key, id, &current, now, true)?;
        }
    }
    put(conn, id, &target.seal(&key, id)?, now)?;
    Ok(target)
}

/// 定向抹一行（迁移与收编用）。走 UPDATE 而不是 `sticky::upsert`：那一拍只做形状搬运，
/// 不该续写"最近改动"的时钟，也不该记一版
fn blank_row(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE stickies SET title = '', body = '', items_json = '[]', timeline_json = '[]', \
         tags_json = '[]' WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

// ──────────────────── 揭开一张（整簇在 ./private_note/legacy.rs） ────────────────────
//
// `reveal` 与旧形状迁移/收编（settle_legacy / migrate_map / adopt 及其帮手）原来住在这里，
// 2026-10-14 随代码审查拆出：这批路径只在"旧形状还没搬完"的窗口期活着，与逐张钥匙
// 主路径分开住，认知负担拆半。`reveal` / `Revealed` 在这里原路 re-export，
// 外部调用点（commands/private.rs、trash.rs 的测试）一个字都不用改。

mod legacy;

pub use legacy::reveal;

/// 改密：把库里那些键行从旧 master 重裹到新 master（内容字节一个都不动）。
/// 由 `private::rekey` 在**改写封套之前**调用，它按返回的回调顺序负责回滚。
/// 键行按新 master 重裹一遍。**不开事务**：改密那一拍要把它与标记写进同一个事务（`rewrap_and_mark`）。
/// 内容字节一个都不动，只重裹包着钥匙的那 32 字节×N 张。
pub fn rewrap_keys(
    conn: &Connection,
    old_master: &[u8],
    new_master: &[u8],
) -> AppResult<usize> {
    let mut stmt = conn.prepare("SELECT note_id, key FROM private_keys")?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut moved = 0usize;
    for (id, packed) in &rows {
        let key = private::open_note_key(old_master, id, packed)?;
        conn.execute(
            "UPDATE private_keys SET key = ?2 WHERE note_id = ?1",
            params![id, private::seal_note_key(new_master, id, &key)?],
        )?;
        moved += 1;
    }
    Ok(moved)
}

/// 改密在库里那一拍的全部：重裹键行 + 写下"这一拍已成"的标记，**一个事务**。
/// 标记与重裹同生同死，启动时的 `recover_stage` 才有两样问得出来的事实
pub fn rewrap_and_mark(
    conn: &Connection,
    old_master: &[u8],
    new_master: &[u8],
) -> AppResult<usize> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    let moved = rewrap_keys(&tx, old_master, new_master)?;
    super::settings::set_conn(&tx, private::STAGE_MARKER_KEY, private::MARKER_DB_DONE)?;
    tx.commit()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    Ok(moved)
}

/// 重置在库里那一拍的全部：三张私密表 + 私密图一并清空，并写下标记，**一个事务**
pub fn purge_and_mark(conn: &Connection) -> AppResult<usize> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    let purged = purge_all(&tx)?;
    super::media::purge_encrypted_conn(&tx)?;
    super::settings::set_conn(&tx, private::STAGE_MARKER_KEY, private::MARKER_DB_DONE)?;
    tx.commit()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    Ok(purged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::legacy::Revealed;
    use crate::db::pool::Db;
    use crate::db::query::{media, sticky};
    use std::path::PathBuf;

    const PW: &str = "口令至少八个字符";
    const PW2: &str = "换个长一点的口令";

    fn db() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yixian-private-note-test-{tag}-{}",
            crate::support::clock::now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 已配置、**一张都没揭开**的一把 vault（封套在临时目录里，与库无关）
    fn configured(tag: &str) -> PrivateVault {
        let vault = PrivateVault::scan(&temp_dir(tag));
        private::setup(&vault, PW).expect("设置口令");
        vault
    }

    /// 已配置且揭开了 `ids` 那几张
    fn opened(db: &Db, tag: &str, ids: &[&str]) -> PrivateVault {
        let vault = configured(tag);
        for id in ids {
            reveal(db, &vault, id, PW).expect("揭开");
        }
        vault
    }

    /// 私密层没启用（直通那条路）
    fn off() -> PrivateVault {
        PrivateVault::disabled("private-note")
    }

    fn input(id: &str, private: bool, body: &str) -> StickyInput {
        StickyInput {
            id: id.to_string(),
            title: format!("标题{id}"),
            body: body.to_string(),
            content_type: "text".into(),
            items: Vec::new(),
            timeline: Vec::new(),
            tags: vec!["工作".into()],
            theme: "yellow".into(),
            pinned: true,
            floating: true,
            collapsed: false,
            is_private: private,
            group_id: None,
            x: None,
            y: None,
            width: None,
            height: None,
            due_at: None,
            done_at: None,
            repeat: "none".into(),
            deleted: false,
            docked: false,
            dock_edge: None,
            icon: None,
            auto_size: None,
        }
    }

    /// 占位形状：一行私密便签在 `stickies` 上该长什么样
    fn placeholder(id: &str) -> StickyInput {
        let mut blank = input(id, true, "");
        blank.title = String::new();
        blank.tags = Vec::new();
        blank
    }

    fn content(body: &str) -> SealedContent {
        SealedContent {
            title: "标题".into(),
            body: body.into(),
            content_type: "text".into(),
            items_json: BLANK_JSON.into(),
            timeline_json: BLANK_JSON.into(),
            tags_json: BLANK_JSON.into(),
        }
    }

    fn raw(db: &Db, id: &str) -> StickyRow {
        sticky::get_raw(db, id).expect("读").expect("行在")
    }

    fn count(db: &Db, table: &str) -> i64 {
        db.lock()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .expect("数")
    }

    /// 表里那一行的密文原字节（测试要按旧形状手工造行、也要确认搬完之后字节变了）
    fn blob(db: &Db, table: &str, id: &str) -> Option<Vec<u8>> {
        db.lock()
            .query_row(
                &format!("SELECT content FROM {table} WHERE note_id = ?1"),
                [id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .expect("读")
    }

    fn key_blob(db: &Db, id: &str) -> Option<Vec<u8>> {
        db.lock()
            .query_row(
                "SELECT key FROM private_keys WHERE note_id = ?1",
                [id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .expect("读")
    }

    /// 给这张挂一张 enc=1 的旧形状图（按整层 mediaKey 封）
    fn legacy_picture(db: &Db, media_id: &str, note_id: &str, key: &[u8], raw_bytes: &[u8]) {
        let packed = crypto::seal_blob(key, &private::media_aad(media_id), raw_bytes).expect("封");
        media::save(
            db,
            &media::MediaRow {
                id: media_id.to_string(),
                note_id: note_id.to_string(),
                mime: "image/png".to_string(),
                bytes: packed,
                enc: true,
                width: 8,
                height: 8,
                created_at: 1,
            },
        )
        .expect("存图");
    }

    /// 封套里那把旧整层正文钥匙（测试手工造旧形状的行要用）
    fn legacy_content_key(vault: &PrivateVault, master: &[u8]) -> Vec<u8> {
        let envelope = private::read_envelope(vault.dir()).expect("读").expect("有");
        private::legacy_content_key(&envelope, master)
            .expect("解")
            .expect("有")
            .to_vec()
    }

    #[test]
    fn 揭开之后写入_行上是占位_真身在表里_读回是合并过的() {
        let db = db();
        let vault = configured("roundtrip");
        reveal(&db, &vault, "p1", PW).expect("揭开");
        let row = sticky::upsert(&db, &vault, input("p1", true, "真身正文")).expect("写");
        assert_eq!(row.body, "真身正文", "返回的必须是合并过的行（flushNow 拿它整份换内存）");
        assert_eq!(row.title, "标题p1");

        let on_disk = raw(&db, "p1");
        assert_eq!(on_disk.body, "", "列上必须是占位");
        assert_eq!(on_disk.title, "");
        assert_eq!(on_disk.tags, Vec::<String>::new());
        assert_eq!(on_disk.content_type, "text", "类型不占位：蒙版也得知道这扇窗什么形状");
        assert_eq!(count(&db, "private_content"), 1);
        assert_eq!(count(&db, "private_keys"), 1, "揭开那一刻就建了键行");
        assert_eq!(count(&db, "private_revision"), 0, "新建没有\"之前\"，不该记版");
    }

    /// 这一条是整场重构的靶心：**开了一张不等于开了整层**
    #[test]
    fn 揭开一张不会把另一张一起开_列表里另一张照旧是占位() {
        let db = db();
        // 两张都先按"没启用私密层"那条路写成明文摊着，然后只给 p1 输一次口令
        sticky::upsert(&db, &off(), input("p1", true, "第一张")).expect("写 p1");
        sticky::upsert(&db, &off(), input("p2", true, "第二张")).expect("写 p2");
        let vault = configured("two-notes");
        reveal(&db, &vault, "p1", PW).expect("只揭开 p1");

        let rows = sticky::list(&db, &vault, false).expect("列表");
        assert_eq!(
            rows.iter().find(|r| r.id == "p1").expect("有").body,
            "第一张",
            "揭开的那张合并成真身"
        );
        assert_eq!(
            rows.iter().find(|r| r.id == "p2").expect("有").body,
            "",
            "没揭开的那张不许被顺手合并"
        );
        assert_eq!(
            vault.revealed_ids(),
            vec!["p1".to_string()],
            "内存里只躺着那一张的钥匙"
        );
        assert!(key_blob(&db, "p1").is_some(), "p1 搬完了");
        assert!(key_blob(&db, "p2").is_none(), "p2 停在旧形状，等它自己第一次被揭开");
    }

    /// 真隔离：两张各自的密文行，互相拿对方的钥匙都解不开。
    /// 旧版一把整层钥匙时这是解得开的——那正是"看着锁着其实开着"
    #[test]
    fn 一张的钥匙解不开另一张的密文行() {
        let db = db();
        let vault = opened(&db, "isolation", &["p1", "p2"]);
        sticky::upsert(&db, &vault, input("p1", true, "第一张的真身")).expect("写 p1");
        sticky::upsert(&db, &vault, input("p2", true, "第二张的真身")).expect("写 p2");

        let k1 = vault.revealed_key("p1").expect("p1 的钥匙");
        let k2 = vault.revealed_key("p2").expect("p2 的钥匙");
        assert_ne!(k1.as_slice(), k2.as_slice(), "两张各自一把随机钥匙");
        let b1 = blob(&db, "private_content", "p1").expect("有");
        let b2 = blob(&db, "private_content", "p2").expect("有");
        assert_eq!(
            SealedContent::open(&k1, "p1", &b1).expect("自己那张解得开").body,
            "第一张的真身"
        );
        assert_eq!(
            SealedContent::open(&k2, "p1", &b1)
                .expect_err("拿别人的钥匙解这一行")
                .code,
            "CRYPTO_OPEN"
        );
        assert_eq!(
            SealedContent::open(&k1, "p2", &b2)
                .expect_err("换 id 也不行（AAD 绑 id）")
                .code,
            "CRYPTO_OPEN"
        );
    }

    #[test]
    fn 没揭开时递上真身_这一拍整个拒绝_库里形状不变() {
        let db = db();
        let vault = opened(&db, "reject-locked", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "旧的那份")).expect("首写");
        private::lock(&vault);

        let err = sticky::upsert(&db, &vault, input("p1", true, "刚打的字"))
            .expect_err("没揭开不许把真身写占位（等于删掉那几个字）");
        assert_eq!(err.code, "PRIVATE_LOCKED");

        reveal(&db, &vault, "p1", PW).expect("再揭开");
        assert_eq!(raw(&db, "p1").body, "", "被拒的这一拍不该动到行（行还是原来的占位）");
        assert_eq!(
            sticky::get(&db, &vault, "p1").expect("读").expect("有").body,
            "旧的那份",
            "表里那份真身原样留着——刚打的字由调用方留在在途里"
        );
        assert_eq!(count(&db, "private_content"), 1);
        assert_eq!(count(&db, "private_revision"), 0, "被拒的那一拍不该留下一版");
    }

    #[test]
    fn 没揭开时递上占位_照写_表里那份原样留着() {
        let db = db();
        let vault = opened(&db, "placeholder-while-locked", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "真身")).expect("首写");
        private::lock(&vault);

        // 翻置顶那一拍：手上只有占位（锁着的窗读到的就是占位）
        let mut flip = placeholder("p1");
        flip.pinned = false;
        sticky::upsert(&db, &vault, flip).expect("占位照写");

        reveal(&db, &vault, "p1", PW).expect("再揭开");
        assert_eq!(raw(&db, "p1").body, "", "行还是占位");
        assert!(!raw(&db, "p1").pinned, "置顶翻过去了");
        assert_eq!(
            sticky::get(&db, &vault, "p1").expect("读").expect("有").body,
            "真身",
            "锁着的一拍不许碰表里那一条"
        );
    }

    /// 揭开着、递上来的却是占位（拿锁定态的旧副本改了一笔下 just 落库）：
    /// 表里那份真身不能被这份空覆盖掉
    #[test]
    fn 揭开着递上占位_不许用空覆盖真身() {
        let db = db();
        let vault = opened(&db, "no-blank-clobber", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "不能丢")).expect("首写");
        sticky::upsert(&db, &vault, placeholder("p1")).expect("占位那一拍");
        assert_eq!(
            sticky::get(&db, &vault, "p1").expect("读").expect("有").body,
            "不能丢",
            "空覆盖不了真身"
        );
        assert_eq!(count(&db, "private_revision"), 0, "也没记成一版空历史");
    }

    #[test]
    fn 硬删连正文版本与键行一起带走_没揭开也删得动() {
        let db = db();
        let vault = opened(&db, "hard-delete", &["p1"]);
        let t0 = 1_700_000_000_000;
        sticky::upsert(&db, &vault, input("p1", true, "第一版")).expect("首写");
        {
            let conn = db.lock();
            save(&conn, &vault, "p1", &content("第二版"), t0, false).expect("改一版");
            save(&conn, &vault, "p1", &content("第三版"), t0 + 61_000, false).expect("再改一版");
        }
        assert_eq!(count(&db, "private_content"), 1);
        assert_eq!(count(&db, "private_revision"), 2, "两次改动各留下一版");

        private::lock(&vault);
        assert!(sticky::delete(&db, "p1", true).expect("硬删"), "删不需要密钥");
        assert_eq!(count(&db, "private_content"), 0, "不留解不开也不可见的孤儿");
        assert_eq!(count(&db, "private_revision"), 0);
        assert_eq!(count(&db, "private_keys"), 0, "键行也得跟着走");
    }

    /// 软删什么都不带走：从回收站恢复回来，内容、版本与键行还得在
    #[test]
    fn 软删不动密文版本与键行() {
        let db = db();
        let vault = opened(&db, "soft-delete", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "第一版")).expect("首写");
        {
            let conn = db.lock();
            save(&conn, &vault, "p1", &content("第二版"), 1_700_000_000_000, false).expect("改");
        }
        sticky::delete(&db, "p1", false).expect("软删");
        assert_eq!(count(&db, "private_content"), 1);
        assert_eq!(count(&db, "private_revision"), 1);
        assert_eq!(count(&db, "private_keys"), 1);

        // 收起来之后再恢复：键行还在 → 重新揭开这一张解得开
        private::lock(&vault);
        crate::db::query::trash::restore(&db, "p1").expect("恢复");
        reveal(&db, &vault, "p1", PW).expect("恢复后揭开");
        assert_eq!(
            sticky::get(&db, &vault, "p1").expect("读").expect("有").body,
            "第二版",
            "回收站走一圈回来，版本与钥匙都还在"
        );
    }

    /// 私密版的"内容没变不占格"：记的是**被换掉之前**那份，所以同一份内容连续写几次，
    /// 只有第一次会把它留成一版
    #[test]
    fn 版本判据_内容没变不占格() {
        let db = db();
        let vault = opened(&db, "revision-same", &["p1"]);
        let t0 = 1_700_000_000_000;
        sticky::upsert(&db, &vault, input("p1", true, "甲")).expect("首写");
        let conn = db.lock();
        save(&conn, &vault, "p1", &content("乙"), t0, false).expect("改乙");
        assert_eq!(revision_list(&conn, &vault, "p1").expect("列").len(), 1);
        assert_eq!(
            revision_list(&conn, &vault, "p1").expect("列")[0].preview,
            "甲",
            "存的是换掉之前那一份"
        );
        save(&conn, &vault, "p1", &content("丁"), t0 + 61_000, false).expect("改丁");
        assert_eq!(revision_list(&conn, &vault, "p1").expect("列").len(), 2);
        save(&conn, &vault, "p1", &content("丁"), t0 + 122_000, false).expect("又写丁");
        assert_eq!(revision_list(&conn, &vault, "p1").expect("列").len(), 3);
        save(&conn, &vault, "p1", &content("丁"), t0 + 183_000, false).expect("再写丁");
        assert_eq!(
            revision_list(&conn, &vault, "p1").expect("列").len(),
            3,
            "内容没变不重复占格"
        );
    }

    /// 打字流被冷却夹住；回滚那一拍（force）绕得过
    #[test]
    fn 版本判据_冷却夹住_force绕过() {
        let db = db();
        let vault = opened(&db, "revision-coalesce", &["p1"]);
        let t0 = 1_700_000_000_000;
        sticky::upsert(&db, &vault, input("p1", true, "甲")).expect("首写");
        let conn = db.lock();
        save(&conn, &vault, "p1", &content("乙"), t0, false).expect("改乙");
        assert_eq!(revision_list(&conn, &vault, "p1").expect("列").len(), 1, "rev1 = 甲");

        save(&conn, &vault, "p1", &content("丙"), t0 + 5_000, false).expect("改丙");
        assert_eq!(revision_list(&conn, &vault, "p1").expect("列").len(), 1, "被冷却夹住");

        save(&conn, &vault, "p1", &content("丁"), t0 + 61_000, false).expect("改丁");
        let rows = revision_list(&conn, &vault, "p1").expect("列");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].preview, "丙", "新的在前");

        save(&conn, &vault, "p1", &content("戊"), t0 + 62_000, false).expect("改戊");
        assert_eq!(revision_list(&conn, &vault, "p1").expect("列").len(), 2);

        save(&conn, &vault, "p1", &content("己"), t0 + 63_000, true).expect("force");
        let rows = revision_list(&conn, &vault, "p1").expect("列");
        assert_eq!(rows.len(), 3, "force 那一发落下了");
        assert_eq!(rows[0].preview, "戊", "记的是刚被换掉那一份");
    }

    #[test]
    fn 版本保留量按条数与天数两头夹() {
        let db = db();
        let vault = opened(&db, "revision-keep", &["p1"]);
        let t0 = 1_700_000_000_000;
        let conn = db.lock();
        let key = vault.revealed_key("p1").expect("钥匙");
        for seq in 1..=60 {
            let packed =
                seal_revision(&key, "p1", seq, &content(&format!("第{seq}版"))).expect("封");
            conn.execute(
                "INSERT INTO private_revision (note_id, seq, content, created_at) VALUES (?1, ?2, ?3, ?4)",
                params!["p1", seq, packed, t0],
            )
            .expect("灌版本");
        }
        prune_revisions(&conn, "p1", t0).expect("清理");
        drop(conn);
        let conn = db.lock();
        let rows = revision_list(&conn, &vault, "p1").expect("列");
        assert_eq!(rows.len(), KEEP_PER_NOTE as usize, "只留最新 50 条");
        assert_eq!(rows[0].seq, 60, "新的在前");
        assert_eq!(rows.last().expect("最老那条").seq, 11, "1..=10 被挤掉");

        conn.execute(
            "INSERT INTO private_revision (note_id, seq, content, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                "p1",
                900,
                seal_revision(&key, "p1", 900, &content("很久以前")).expect("封"),
                t0 - (KEEP_DAYS + 1) * DAY_MS
            ],
        )
        .expect("灌一条过期的");
        prune_revisions(&conn, "p1", t0).expect("再清理");
        assert_eq!(revision_list(&conn, &vault, "p1").expect("列").len(), 50);
    }

    #[test]
    fn 回滚到某一版_并把回滚前那份强记成一版() {
        let db = db();
        let vault = opened(&db, "revert", &["p1"]);
        let t0 = 1_700_000_000_000;
        sticky::upsert(&db, &vault, input("p1", true, "第一版")).expect("首写");
        {
            let conn = db.lock();
            save(&conn, &vault, "p1", &content("第二版"), t0, false).expect("改二");
            save(&conn, &vault, "p1", &content("第三版"), t0 + 61_000, false).expect("改三");
            let back = revert(&conn, &vault, "p1", 1, t0 + 62_000).expect("回滚");
            assert_eq!(back.body, "第一版");
            assert_eq!(
                load(&conn, &vault, "p1").expect("读").expect("有").body,
                "第一版"
            );
            let rows = revision_list(&conn, &vault, "p1").expect("列");
            assert_eq!(rows.len(), 3, "回滚前那份（第三版）必须强记成一版");
            assert_eq!(rows[0].preview, "第三版", "刚被换掉的那一份才是要救的那个");
        }
        // 行上一个字都没动：私密便签的行永远是占位（这句要放到锁外面，`raw` 自己取锁）
        assert_eq!(raw(&db, "p1").body, "");
    }

    /// 把 p1 那条密文挂到 p2 名下：解不开，而不是解出别人的内容。
    /// AAD 绑 id + 钥匙绑张，两道锁
    #[test]
    fn 密文钉在自己那张上_换一行就解不开() {
        let db = db();
        let vault = opened(&db, "aad-binding", &["p1", "p2"]);
        sticky::upsert(&db, &vault, input("p1", true, "第一张的真身")).expect("写 p1");
        sticky::upsert(&db, &vault, input("p2", true, "第二张的真身")).expect("写 p2");
        {
            let conn = db.lock();
            conn.execute("DELETE FROM private_content WHERE note_id = 'p2'", [])
                .expect("摘掉 p2");
            conn.execute(
                "UPDATE private_content SET note_id = 'p2' WHERE note_id = 'p1'",
                [],
            )
            .expect("把 p1 那条挪到 p2 名下");
            let err = load(&conn, &vault, "p2").expect_err("换一张就解不开");
            assert_eq!(err.code, "CRYPTO_OPEN");
        }
        // 合并这一张时不许把整屏拖垮：解不开就按占位显示
        let rows = sticky::list(&db, &vault, false).expect("列表");
        let p2 = rows.iter().find(|row| row.id == "p2").expect("在");
        assert_eq!(p2.body, "", "解不开的那张按占位显示");
        assert!(p2.is_private);
        assert_eq!(
            rows.iter().find(|row| row.id == "p1").expect("在").body,
            "",
            "p1 那一条已经挪走了，它也只能是占位"
        );
    }

    /// 锁着的张一行都不动：那时看到的就是占位
    #[test]
    fn 全部收回之后_列表里全是占位_公开那张不受影响() {
        let db = db();
        let vault = opened(&db, "merge-list", &["p1"]);
        sticky::upsert(&db, &vault, input("s1", false, "公开的正文")).expect("写公开");
        sticky::upsert(&db, &vault, input("p1", true, "私密的正文")).expect("写私密");

        let rows = sticky::list(&db, &vault, false).expect("列表");
        assert_eq!(rows.len(), 2);
        for row in rows {
            assert_eq!(row.body, if row.is_private { "私密的正文" } else { "公开的正文" });
        }

        private::lock(&vault);
        let rows = sticky::list(&db, &vault, false).expect("锁着也列得出来");
        assert_eq!(
            rows.iter().find(|r| r.is_private).expect("有").body,
            "",
            "锁着就是占位，界面据此落蒙版"
        );
        assert_eq!(
            rows.iter().find(|r| !r.is_private).expect("有").body,
            "公开的正文",
            "公开那张不受影响"
        );
    }

    /// 1.2.9 那批整层密文：等这张第一次被揭开时当场搬进它自己的钥匙，
    /// 而**没被揭开的那些张停在旧形状**——不是一次全搬
    #[test]
    fn 揭开时把这张从旧整层钥匙搬进自己的钥匙() {
        let db = db();
        let vault = configured("move-legacy");
        // 手工造 1.2.9 的形状：两行的正文都封在整层 contentKey 下，一张键行都没有
        let master = private::master_of(&vault, PW).expect("master");
        // 先让封套里有 contentKey（旧版第一次解锁时就是它补的）
        private::ensure_legacy_content_key(&vault, &master).expect("补旧钥匙");
        let old = legacy_content_key(&vault, &master);
        let t0: i64 = 1_700_000_000_000;
        sticky::upsert(&db, &off(), input("p1", true, "摊着的旧字")).expect("写明文行 p1");
        sticky::upsert(&db, &off(), input("p2", true, "摊着的旧字二")).expect("写明文行 p2");
        {
            let conn = db.lock();
            for (id, body) in [("p1", "第一张的旧正文"), ("p2", "第二张的旧正文")] {
                let packed = content(body).seal(&old, id).expect("旧钥匙封");
                conn.execute(
                    "INSERT INTO private_content (note_id, content, updated_at) VALUES (?1, ?2, ?3)",
                    params![id, packed, t0],
                )
                .expect("灌旧行");
                conn.execute(
                    "INSERT INTO private_revision (note_id, seq, content, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![id, 1, seal_revision(&old, id, 1, &content("更早")).expect("封"), t0 - 1],
                )
                .expect("灌旧版本");
            }
        }
        assert_eq!(count(&db, "private_keys"), 0);

        let stat = reveal(&db, &vault, "p1", PW).expect("揭开 p1");
        assert_eq!(
            stat,
            Revealed { content: 1, revisions: 1, media: 0 },
            "搬的是这一张自己的正文与历史"
        );
        assert!(key_blob(&db, "p1").is_some(), "p1 有键行了");
        assert!(key_blob(&db, "p2").is_none(), "p2 没被顺手搬（它还没被任何口令开过）");
        // p1 已经换到它自己的钥匙下：旧整层钥匙再也解不开它，而 p2 用旧钥匙照旧解得开
        let p1_blob = blob(&db, "private_content", "p1").expect("有");
        let k1 = vault.revealed_key("p1").expect("p1 的钥匙");
        assert_eq!(SealedContent::open(&k1, "p1", &p1_blob).expect("新钥匙解得开").body, "第一张的旧正文");
        assert_eq!(
            SealedContent::open(&old, "p1", &p1_blob).expect_err("旧整层钥匙解不开了").code,
            "CRYPTO_OPEN"
        );
        let p2_blob = blob(&db, "private_content", "p2").expect("有");
        assert_eq!(
            SealedContent::open(&old, "p2", &p2_blob)
                .expect("p2 原样停在旧形状")
                .body,
            "第二张的旧正文"
        );
        // p1 读出真身，p2 读不出
        let rows = sticky::list(&db, &vault, false).expect("列表");
        assert_eq!(rows.iter().find(|r| r.id == "p1").expect("有").body, "第一张的旧正文");
        assert_eq!(rows.iter().find(|r| r.id == "p2").expect("有").body, "");
        // 搬进来的那张还能写
        sticky::upsert(&db, &vault, input("p1", true, "搬完之后又改了")).expect("写");
        assert_eq!(
            sticky::get(&db, &vault, "p1").expect("读").expect("有").body,
            "搬完之后又改了"
        );
        // p2 后来被揭开：也是当场搬，用的还是同一把旧 contentKey
        let stat = reveal(&db, &vault, "p2", PW).expect("揭开 p2");
        assert_eq!(stat.content, 1);
        assert_eq!(
            sticky::get(&db, &vault, "p2").expect("读").expect("有").body,
            "第二张的旧正文"
        );
    }

    /// 搬的时候把 `private_content.updated_at` 原样留着：那是"最近改动"的时钟，
    /// 换个存储形状不该把它跳到现在
    #[test]
    fn 搬运不改最近改动的时钟() {
        let db = db();
        let vault = configured("move-clock");
        let master = private::master_of(&vault, PW).expect("master");
        private::ensure_legacy_content_key(&vault, &master).expect("补旧钥匙");
        let old = legacy_content_key(&vault, &master);
        let long_ago = 1_600_000_000_000;
        sticky::upsert(&db, &off(), input("p1", true, "摊着")).expect("写行");
        {
            let conn = db.lock();
            conn.execute(
                "INSERT INTO private_content (note_id, content, updated_at) VALUES (?1, ?2, ?3)",
                params!["p1", content("旧正文").seal(&old, "p1").expect("封"), long_ago],
            )
            .expect("灌旧行");
        }
        reveal(&db, &vault, "p1", PW).expect("揭开");
        let kept: i64 = db
            .lock()
            .query_row(
                "SELECT updated_at FROM private_content WHERE note_id = ?1",
                ["p1"],
                |row| row.get(0),
            )
            .expect("读");
        assert_eq!(kept, long_ago, "搬完了，时钟还是那一天");
    }

    /// 旧形状的图片：揭开时重裹成这张自己的钥匙。整笔在同一个事务里——
    /// 任何一张解不开就整笔回滚、这次揭开不作数（不许留下"键行有了、图还停在旧钥匙下"）
    #[test]
    fn 揭开时把它名下的旧图重裹成自己的钥匙() {
        let db = db();
        let vault = configured("move-media");
        let master = private::master_of(&vault, PW).expect("master");
        let envelope = private::read_envelope(vault.dir()).expect("读").expect("有");
        let media_old = private::legacy_media_key(&envelope, &master)
            .expect("解")
            .expect("有");
        sticky::upsert(&db, &off(), input("p1", true, "摊着")).expect("写 p1");
        sticky::upsert(&db, &off(), input("p2", true, "摊着二")).expect("写 p2");
        legacy_picture(&db, "m1", "p1", &media_old, b"png-bytes-one");
        legacy_picture(&db, "m2", "p1", &media_old, b"png-bytes-two");
        legacy_picture(&db, "m3", "p2", &media_old, b"png-bytes-three");

        let stat = reveal(&db, &vault, "p1", PW).expect("揭开 p1");
        assert_eq!(stat.media, 2, "只搬 p1 名下那两张");
        let k1 = vault.revealed_key("p1").expect("钥匙");
        for (mid, want) in [("m1", b"png-bytes-one".as_slice()), ("m2", b"png-bytes-two".as_slice())] {
            let row = media::get(&db, mid).expect("读").expect("有");
            assert!(row.enc, "还是密文行");
            let raw = crypto::open_blob(&k1, &private::media_aad(mid), &row.bytes).expect("新钥匙解得开");
            assert_eq!(raw.as_slice(), want, "字节一个都不动，只是换了包它的钥匙");
        }
        // p2 那张图原样停在旧 mediaKey 下（p2 还没被口令开过）：旧钥匙解得开，
        // 而 p1 的钥匙解不开它
        let untouched = media::get(&db, "m3").expect("读").expect("有");
        assert!(untouched.enc, "还是密文行");
        assert_eq!(
            crypto::open_blob(&media_old, &private::media_aad("m3"), &untouched.bytes)
                .expect("旧媒体钥匙仍然解得开")
                .len(),
            b"png-bytes-three".len()
        );
        assert_eq!(
            crypto::open_blob(&k1, &private::media_aad("m3"), &untouched.bytes)
                .expect_err("别的张的钥匙解不开它")
                .code,
            "CRYPTO_OPEN"
        );
    }

    /// 图有一张坏了：整个揭开回滚。留下"键行有、图还解不开"的状态是最难查的那种
    #[test]
    fn 有一张图解不开时这次揭开整笔不算() {
        let db = db();
        let vault = configured("media-corrupt");
        let master = private::master_of(&vault, PW).expect("master");
        private::ensure_legacy_content_key(&vault, &master).expect("补旧钥匙");
        sticky::upsert(&db, &off(), input("p1", true, "摊着")).expect("写 p1");
        // 一张"按旧媒体钥匙封着"却其实用别的钥匙封的图——解不开的那种
        legacy_picture(&db, "m1", "p1", &master, "这张图解不开".as_bytes());

        let err = reveal(&db, &vault, "p1", PW).expect_err("必须整笔失败");
        assert_eq!(err.code, "CRYPTO_OPEN");
        assert!(key_blob(&db, "p1").is_none(), "键行没落下");
        assert!(vault.revealed_ids().is_empty(), "揭开没成，内存里不许多出一张");
        assert!(
            media::get(&db, "m1").expect("读").expect("有").enc,
            "图还是密文行：没被搬成解不开的半截状态"
        );

        // 那张坏图摘掉之后再来一次：同一次口令流程重走，正文一个字都没丢
        media::delete(&db, "m1").expect("摘掉坏图");
        reveal(&db, &vault, "p1", PW).expect("再来一次");
        assert_eq!(
            sticky::get(&db, &vault, "p1").expect("读").expect("有").body,
            "摊着",
            "第一次失败没把行上的字弄丢（收编那一趟也是原样搬）"
        );
    }

    /// 口令不对：一步都不做
    #[test]
    fn 口令不对时库里与内存都不许变() {
        let db = db();
        let vault = configured("bad-password");
        sticky::upsert(&db, &vault, placeholder("p1")).expect("先落一行私密占位");
        let keys_before = count(&db, "private_keys");
        let err = reveal(&db, &vault, "p1", "错口令八个字").expect_err("必须失败");
        assert_eq!(err.code, "CRYPTO_OPEN");
        assert!(vault.revealed_ids().is_empty());
        assert_eq!(count(&db, "private_keys"), keys_before, "一个键行都不许多");
    }

    /// 表里有旧形状的行、封套里却没有 contentKey（换回了一份旧封套、或旧快照配上了
    /// 新一半的库）：必须停下来报错。放行的话就是现造一把新钥匙 + 那些行永远解不开
    #[test]
    fn 旧形状的行对不上钥匙时报错不硬搬() {
        let db = db();
        let vault = configured("key-mismatch");
        let master = private::master_of(&vault, PW).expect("master");
        // 先补一把 contentKey 灌一行，再把封套换成"没有 contentKey 的那份 v1"
        private::ensure_legacy_content_key(&vault, &master).expect("补旧钥匙");
        let old = legacy_content_key(&vault, &master);
        sticky::upsert(&db, &off(), input("p1", true, "摊着")).expect("写行");
        {
            let conn = db.lock();
            conn.execute(
                "INSERT INTO private_content (note_id, content, updated_at) VALUES (?1, ?2, ?3)",
                params!["p1", content("旧正文").seal(&old, "p1").expect("封"), 1],
            )
            .expect("灌旧行");
        }
        private::v1_downgrade(&vault, &master, "{}", false).expect("换成没钥匙的旧封套");

        let err = reveal(&db, &vault, "p1", PW).expect_err("必须拒绝");
        assert_eq!(err.code, "MIGRATE_KEY_MISMATCH");
        assert!(key_blob(&db, "p1").is_none(), "一条都不许多写或改写");
        assert_eq!(count(&db, "private_content"), 1);
        assert!(vault.revealed_ids().is_empty(), "被拒这一次不算揭开");
    }

    /// 整册 map（v1，比 1.2.9 还早的形状）：第一次揭开任意一张时当场拆进表，
    /// 拆完把封套推到 v2 并留底；这一张顺带搬进自己的钥匙，别的张停在旧形状
    #[test]
    fn 第一次揭开把旧封套那本整册map拆进表() {
        let db = db();
        let vault = configured("migrate-map");
        let master = private::master_of(&vault, PW).expect("master");
        // 行先按"没启用私密层"那条路写成明文（v1 时代那些张就是这样摊着的）
        sticky::upsert(&db, &off(), input("p1", true, "行上摊着的旧字")).expect("写 p1");
        sticky::upsert(&db, &off(), input("p2", false, "已经翻回公开")).expect("写 p2");

        let map = r#"{
            "p1":{"title":"旧标题","body":"旧正文","contentType":"text","items":[],"timeline":[],
                  "tags":["工作"],"revisions":[
                    {"seq":1,"createdAt":1700000000000,
                     "content":{"title":"更早","body":"更早正文","contentType":"text",
                                "items":[],"timeline":[],"tags":[]}}]},
            "p2":{"title":"p2 的旧条目","body":"这张早就不私密了","contentType":"text",
                  "items":[],"timeline":[],"tags":[]},
            "连行都没了":{"title":"孤儿","body":"硬删时没摘掉的那条","contentType":"text",
                          "items":[],"timeline":[],"tags":[]}
        }"#;
        private::v1_downgrade(&vault, &master, map, false).expect("伪装成 v1");

        let stat = reveal(&db, &vault, "p1", PW).expect("揭开 p1（顺带迁移）");
        assert_eq!(stat.content, 1, "拆出来的那一行当场又搬进了 p1 自己的钥匙");
        assert_eq!(stat.revisions, 1, "旧 map 里那一版也跟过来了");
        assert!(
            private::read_envelope(vault.dir())
                .expect("读")
                .expect("有")
                .data
                .is_none(),
            "封套已推到 v2"
        );
        let rows = sticky::list(&db, &vault, false).expect("列表");
        let p1 = rows.iter().find(|r| r.id == "p1").expect("有");
        assert_eq!(p1.body, "旧正文", "p1 开着：读得到真身");
        assert_eq!(
            raw(&db, "p2").body,
            "已经翻回公开",
            "p2 早就不是私密的了：旧 map 里那条被丢掉，行原样"
        );
        // 旧 map 里没有便签行对应的那些不留在库里
        assert_eq!(
            db.lock()
                .query_row(
                    "SELECT COUNT(*) FROM private_content WHERE note_id = '连行都没了'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("数"),
            0
        );
    }

    /// 断在中间重跑一次：已经搬过去的不能被旧 map 换回去
    #[test]
    fn map迁移重跑是幂等() {
        let db = db();
        let vault = configured("migrate-idempotent");
        let master = private::master_of(&vault, PW).expect("master");
        sticky::upsert(&db, &off(), input("p1", true, "行上的字")).expect("写 p1");
        private::v1_downgrade(&vault, &master, r#"{"p1":{"body":"第一份","contentType":"text"}}"#, false)
            .expect("伪装 v1");
        reveal(&db, &vault, "p1", PW).expect("第一次揭开");

        // 假装上一次跑到这里断了：搬过一行，封套却还是 v1 带着旧 map（这次留着 contentKey）
        private::v1_downgrade(
            &vault,
            &master,
            r#"{"p1":{"body":"第二份","contentType":"text"}}"#,
            true,
        )
        .expect("再伪装 v1");
        private::lock(&vault);
        reveal(&db, &vault, "p1", PW).expect("第二次揭开");
        let conn = db.lock();
        assert_eq!(
            load(&conn, &vault, "p1").expect("读").expect("有").body,
            "第一份",
            "库里那份才是此刻的形状，旧 map 不该把它换回去"
        );
    }

    /// 收编：行上还摊着字的私密便签封进表、行抹成占位，**不续写"最近改动"的时钟**。
    /// 这一次跑的是第一次揭开（那时手上才有 master）
    #[test]
    fn 第一次揭开把明文摊着的私密便签收进套() {
        let db = db();
        let vault = configured("adopt");
        // 两条来源：私密层启用前就标过私密的（这里走"没启用"那条路造出明文行）
        sticky::upsert(&db, &off(), input("p1", true, "摊着的真身")).expect("写 p1");
        sticky::upsert(&db, &off(), input("p2", true, "第二张")).expect("写 p2");
        let clock_p1 = raw(&db, "p1").updated_at;

        reveal(&db, &vault, "p1", PW).expect("揭开 p1");
        assert_eq!(count(&db, "private_keys"), 1, "只有 p1 有键行");
        assert_eq!(raw(&db, "p1").body, "", "p1 的行改成空占位");
        assert_eq!(raw(&db, "p2").body, "", "p2 也在这一趟被收进套（旧形状，没有键行）");
        assert_eq!(raw(&db, "p1").updated_at, clock_p1, "收编不续写\"最近改动\"");
        assert_eq!(raw(&db, "p2").content_type, "text", "类型不占位");

        // p1 是真身，p2 还在旧钥匙下：读不出来，等它自己被揭开
        assert_eq!(
            sticky::get(&db, &vault, "p1").expect("读").expect("有").body,
            "摊着的真身"
        );
        assert_eq!(sticky::get(&db, &vault, "p2").expect("读").expect("有").body, "");
        reveal(&db, &vault, "p2", PW).expect("揭开 p2");
        assert_eq!(
            sticky::get(&db, &vault, "p2").expect("读").expect("有").body,
            "第二张"
        );

        // 再揭开一次 p1：无字可搬，键行原样，什么账都不多
        private::lock(&vault);
        reveal(&db, &vault, "p1", PW).expect("重揭 p1");
        assert_eq!(count(&db, "private_keys"), 2);
    }

    /// 表里已经有真身、行上还留着字 = 上一次收编断在两步之间。那时表里那份才作数，
    /// 行上的字是残骸：照样抹掉，但不许拿它覆盖表里那份
    #[test]
    fn 收编时行上是残骸_抹掉而不覆盖表里那份() {
        let db = db();
        let vault = opened(&db, "adopt-residue", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "表里那份")).expect("写进套");
        // 人为把行写成有字（模拟断在两步之间）
        db.lock()
            .execute("UPDATE stickies SET body = '行上的残骸' WHERE id = 'p1'", [])
            .expect("写残骸");

        private::lock(&vault);
        reveal(&db, &vault, "p2", PW).expect("揭开另一张，顺带收编");
        assert_eq!(raw(&db, "p1").body, "", "残骸抹掉");
        assert!(
            blob(&db, "private_content", "p1").is_some(),
            "p1 的真身还在表里（旧形状那一侧）"
        );
        reveal(&db, &vault, "p1", PW).expect("再揭开 p1");
        assert_eq!(
            sticky::get(&db, &vault, "p1").expect("读").expect("有").body,
            "表里那份",
            "真身以表里那份为准"
        );
    }

    #[test]
    fn 孤儿收割_键行也收_刚揭开那张不算孤儿() {
        let db = db();
        let vault = configured("reap");
        reveal(&db, &vault, "p1", PW).expect("揭开 p1");
        reveal(&db, &vault, "p2", PW).expect("揭开 p2");
        sticky::upsert(&db, &vault, input("p1", true, "活着的")).expect("写 p1");
        sticky::upsert(&db, &vault, input("p2", true, "会被绕过删掉的")).expect("写 p2");
        {
            let conn = db.lock();
            save(&conn, &vault, "p2", &content("p2 的第二版"), 1_700_000_000_000, false)
                .expect("给 p2 灌一版");
        }
        // 收回去，然后只揭开 p3——它是"刚揭开、行还没落库"的那一张：前端先要口令
        // （当场建键行），那次写还要过 250ms 去抖才进 stickies。这一拍把它当孤儿删掉，
        // 落库封进去的正文就再也没有钥匙对得上
        private::lock(&vault);
        reveal(&db, &vault, "p3", PW).expect("揭开一张还不存在的便签");
        {
            let conn = db.lock();
            // 绕过包装层直接删行（旧实现里回收站那条路就是这么留下角色的）
            conn.execute("DELETE FROM stickies WHERE id = 'p2'", [])
                .expect("裸删行");
            // 一条正文 + 一版历史 + 一条键行
            assert_eq!(reap_orphans(&conn, &vault.revealed_ids()).expect("收割"), 3);
        }
        assert_eq!(count(&db, "private_content"), 1, "活着的那张不受牵连");
        assert_eq!(count(&db, "private_revision"), 0);
        assert!(key_blob(&db, "p2").is_none(), "p2 行没了也没人揭着：键行一起收掉");
        assert!(
            key_blob(&db, "p3").is_some(),
            "揭着的那张不许被当成孤儿删掉钥匙"
        );
    }

    #[test]
    fn 重置之后三张表整批清光() {
        let db = db();
        let vault = opened(&db, "purge-all", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "一张")).expect("写 p1");
        {
            let conn = db.lock();
            save(&conn, &vault, "p1", &content("两张改动"), 1_700_000_000_000, false).expect("改");
            assert!(purge_all(&conn).expect("清空") >= 3);
        }
        assert_eq!(count(&db, "private_content"), 0);
        assert_eq!(count(&db, "private_revision"), 0);
        assert_eq!(count(&db, "private_keys"), 0, "键行也得清：新 master 再也解不开旧的");
    }

    #[test]
    fn 取消私密_真身回到行上_密文与键行一起摘掉() {
        let db = db();
        let vault = opened(&db, "unmark", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "私密时的正文")).expect("写私密");
        {
            let conn = db.lock();
            save(&conn, &vault, "p1", &content("改过一版"), 1_700_000_000_000, false).expect("改");
        }
        assert_eq!(count(&db, "private_revision"), 1);

        // 前端此刻手上是合并过的内容，翻面就是把它写明文
        sticky::upsert(&db, &vault, input("p1", false, "改过一版")).expect("翻回公开");
        assert_eq!(raw(&db, "p1").body, "改过一版", "真身回到行上");
        assert_eq!(count(&db, "private_content"), 0, "表里那条摘掉");
        assert_eq!(count(&db, "private_revision"), 0, "连着它那一串版本一起摘");
        assert_eq!(count(&db, "private_keys"), 0, "键行也摘：这张不再需要钥匙了");
    }

    /// 翻回公开却递上来一份空：那是读不到真身的一份旧副本。把表里那份搬回行上，
    /// 而不是公布一张空壳——旧实现这里正好会把内容抹掉
    #[test]
    fn 取消私密但手上没字_用表里那份补() {
        let db = db();
        let vault = opened(&db, "unmark-blank", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "不能丢的正文")).expect("写私密");
        let mut publish_blank = input("p1", false, "");
        publish_blank.title = String::new();
        publish_blank.tags = Vec::new();
        sticky::upsert(&db, &vault, publish_blank).expect("翻公开");
        assert_eq!(
            raw(&db, "p1").body,
            "不能丢的正文",
            "行上写的必须是表里那份真身"
        );
        assert_eq!(count(&db, "private_content"), 0);
    }

    /// 没揭开时"翻回公开"必须拒绝：读不出真身就把空壳公布出去，是丢数据
    #[test]
    fn 没揭开不许把读不出真身的那张翻成公开() {
        let db = db();
        let vault = opened(&db, "publish-locked", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "表里有真身")).expect("写私密");
        private::lock(&vault);
        let err = sticky::upsert(&db, &vault, input("p1", false, "外面递来的"))
            .expect_err("必须拒绝");
        assert_eq!(err.code, "PRIVATE_LOCKED");
        assert_eq!(count(&db, "private_content"), 1, "被拒这一拍不许摘掉表里那条");
        assert_eq!(count(&db, "private_keys"), 1, "键行也不许摘");
    }

    /// 表里干净的一张公开便签：直通，多一次 SELECT 之外什么都不动。
    /// （公开那张根本不需要揭开——`reveal` 是给私密正文用的，这里刻意用一把没揭开任何
    /// 一张的 vault，免得测试自己造出"没有键行才是常态"的反例）
    #[test]
    fn 公开便签那条路一行都不碰密文表() {
        let db = db();
        let vault = configured("plain");
        sticky::upsert(&db, &vault, input("s1", false, "公开正文")).expect("写");
        sticky::upsert(&db, &vault, input("s1", false, "改一笔")).expect("改写");
        assert_eq!(count(&db, "private_content"), 0);
        assert_eq!(count(&db, "private_revision"), 0);
        assert_eq!(count(&db, "private_keys"), 0, "公开的张不该有键行");
        assert_eq!(raw(&db, "s1").body, "改一笔");
    }

    /// 没配置 = 直通：那一行的六个字段照原样写明文（与图片那条口径一字不差）
    #[test]
    fn 私密层没配置时直通_不落任何密文() {
        let db = db();
        let row = sticky::upsert(&db, &off(), input("p1", true, "明文躺着的私密便签")).expect("写");
        assert_eq!(row.body, "明文躺着的私密便签");
        assert_eq!(raw(&db, "p1").body, "明文躺着的私密便签");
        assert_eq!(count(&db, "private_content"), 0);
        assert_eq!(count(&db, "private_keys"), 0);
    }

    /// 改密：内容字节一个都不动，只有包钥匙的那 32 字节×N 重裹一遍
    #[test]
    fn 改密重裹键行_内容一个字节都不动() {
        let db = db();
        let vault = opened(&db, "rekey", &["p1"]);
        sticky::upsert(&db, &vault, input("p1", true, "改密之前的正文")).expect("写");
        let content_before = blob(&db, "private_content", "p1").expect("有");
        let key_before = key_blob(&db, "p1").expect("有");

        let old = private::master_of(&vault, PW).expect("旧 master");
        // 新封套（`private::rekey` 负责写）+ 库里重裹：这里只测重裹这一半
        private::rekey(&vault, PW, PW2, |from, to| {
            let conn = db.lock();
            rewrap_keys(&conn, from, to)
        })
        .expect("改密");
        assert!(vault.revealed_ids().is_empty(), "改密之后原来开着的张不再算数");

        let content_after = blob(&db, "private_content", "p1").expect("有");
        let key_after = key_blob(&db, "p1").expect("有");
        assert_eq!(content_before, content_after, "正文行一个字节都没动");
        assert_ne!(key_before, key_after, "键行换成了新 master 包的那份");

        let new = private::master_of(&vault, PW2).expect("新 master");
        assert_eq!(
            private::open_note_key(&new, "p1", &key_after).expect("新口令解得开").as_slice(),
            vault_key_of_old(&old, "p1", &key_before).as_slice(),
            "重裹前后是同一把钥匙：所以内容不必动"
        );
        assert_eq!(
            private::open_note_key(&old, "p1", &key_after)
                .expect_err("旧口令已经解不开键行了")
                .code,
            "CRYPTO_OPEN"
        );
        // 用新口令再揭开一次，读回来的还是那份正文
        reveal(&db, &vault, "p1", PW2).expect("新口令揭开");
        assert_eq!(
            sticky::get(&db, &vault, "p1").expect("读").expect("有").body,
            "改密之前的正文"
        );
    }

    /// 旧包在新 master 下解不开，所以测试要拿旧 master 解出"重裹前那把钥匙"来对比
    fn vault_key_of_old(old: &[u8], id: &str, packed: &[u8]) -> Vec<u8> {
        private::open_note_key(old, id, packed).expect("旧 master 解得开旧包").to_vec()
    }

    /// 一张都没揭开时，改密也不该有东西可重裹（空表也要走得通）
    #[test]
    fn 没有键行时改密的重裹是空跑() {
        let db = db();
        let vault = configured("rekey-empty");
        let moved = private::rekey(&vault, PW, PW2, |from, to| {
            let conn = db.lock();
            rewrap_keys(&conn, from, to)
        })
        .expect("改密");
        assert_eq!(moved, 0);
    }

    /// 封套读不出来时挡的是"碰私密的那一拍"：要标私密的、以及表里还压着它那条密文的，停手；
    /// 公开且没有密文行的照常写——坏掉的那一份不该把整库一起钉住
    #[test]
    fn 坏封套只挡碰私密的那一拍() {
        let db = db();
        let dir = temp_dir("damaged-plan");
        std::fs::write(private::envelope_path(&dir), "不是封套").expect("写坏封套");
        let vault = PrivateVault::scan(&dir);
        assert!(vault.is_damaged(), "用例自己先把\"坏了\"立起来");

        let conn = db.lock();
        let public = input("pub", false, "公开的那张");
        let content = SealedContent::from_input(&public, "[]", "[]", r#"["工作"]"#);
        assert!(
            matches!(
                plan(&conn, &vault, "pub", false, &content).expect("公开那张照旧"),
                Plan::Plain
            ),
            "没碰私密的写入不受影响"
        );

        let want = input("p1", true, "要标成私密的");
        let content = SealedContent::from_input(&want, "[]", "[]", r#"["工作"]"#);
        assert_eq!(
            plan(&conn, &vault, "p1", true, &content)
                .expect_err("要写私密就停")
                .code,
            "PRIVATE_DAMAGED"
        );

        // 这一拍要写的是公开，可表里还压着它解不开的那条：写明文等于把两条永远分家
        conn.execute(
            "INSERT INTO private_content (note_id, content, updated_at) VALUES ('p2', ?1, 1)",
            [vec![0u8; 4]],
        )
        .expect("塞一条密文行");
        let published = input("p2", false, "翻回公开的那张");
        let content = SealedContent::from_input(&published, "[]", "[]", r#"["工作"]"#);
        assert_eq!(
            plan(&conn, &vault, "p2", false, &content)
                .expect_err("表里还压着解不开的那条")
                .code,
            "PRIVATE_DAMAGED"
        );
    }
}
