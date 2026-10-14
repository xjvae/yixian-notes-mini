// legacy — 旧形状的迁移与收编：v1 整册 map 拆条、明文残骸收编、逐张搬运（reveal 的三步）。
//
// 从 private_note.rs 拆出（原 606-991 行）：这些路径只在"旧形状还没搬完"的窗口期活着，
// 与逐张钥匙主路径挤在一起时是全库认知负担最重的一处。搬完即闲：全部路径幂等，
// 库里没有旧形状行后这一整个模块就只剩 `reveal` 那条"已有键行 → 解钥匙进内存"的快路。
//
// 依赖口径：父模块（private_note）的私有件（SealedContent / seal_revision / put / …）
// 子模块可以直接用——Rust 的可见性是"定义模块及其后代"，不必为此把它们改成 pub。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    blank_row, current_packed, exists, open_revision, put, seal_revision, BLANK_JSON,
    SealedContent,
};
use crate::data::crypto;
use crate::data::private::{self, PrivateVault};
use crate::db::models::{StickyItem, TimelineEntry};
use crate::db::pool::Db;
use crate::support::error::{AppError, AppResult};
use crate::support::log;

// ──────────────────────────── 揭开一张 ────────────────────────────

/// 一次 `reveal` 搬了多少东西（只给日志和测试看，前端不需要）
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Revealed {
    /// 从旧形状（整层 contentKey）搬进这张自己钥匙的正文条数
    pub content: usize,
    /// 同上一版的历史条数
    pub revisions: usize,
    /// 这张名下被重裹成"这张自己的钥匙"的图
    pub media: usize,
}

/// **揭开一张**：口令 → master → 那一张的钥匙；成功后 `vault` 里只多了这一张。
///
/// 三步，顺序不能换：`settle_legacy`（只有此刻拿着 master 才做得到的全局旧活）→
/// 这一张的搬运：正文、历史、图 + 键行，**一个事务**（键行是最后那发 INSERT，它一旦落库
/// 就对外宣称"这张的字节全在自己钥匙下"，前面任何一步没成都不能留下它）→ 提交之后才
/// `vault.reveal`（反过来就是"界面说开着、一读就解不开"）。口令不对则一步都到不了。
pub fn reveal(db: &Db, vault: &PrivateVault, id: &str, password: &str) -> AppResult<Revealed> {
    // 口令只在这里消费，master 只活到这一格结束（`Zeroizing` 出作用域就抹）
    let (master, _) = private::master_and_envelope(vault, password)?;
    // settle 可能往封套里补一把 contentKey，所以旧钥匙必须在它**之后**再解一次
    settle_legacy(db, vault, &master)?;
    let envelope = private::read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    let legacy_content = private::legacy_content_key(&envelope, &master)?;
    let legacy_media = private::legacy_media_key(&envelope, &master)?;

    let conn = db.lock();
    // 已经有键行：这张早搬完了，只要把钥匙解出来放进内存
    if let Some(packed_key) = key_row(&conn, id)? {
        let key = private::open_note_key(&master, id, &packed_key)?;
        drop(conn);
        vault.reveal(id, key);
        return Ok(Revealed::default());
    }
    // 旧形状的行在、整层正文钥匙却不在 → 这两样对不上号（换回了一份旧封套，
    // 或旧快照那份配上了新一半的库）。这一步不拦，下面就是**造一把新钥匙 +
    // 把那些行原样留着**，界面上它永远"解不开"，而看上去和"锁着"一模一样
    if legacy_content.is_none() && legacy_needing_content(&conn, id)? {
        return Err(key_mismatch(id));
    }

    let key = private::new_note_key();
    let now = crate::db::query::sticky::now_ms();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    let mut stat = Revealed::default();

    // 正文：旧钥匙解出来、这张的钥匙封回去。updated_at 原样留着（那是"最近改动"的时钟，
    // 搬个形状不该把它跳到现在）
    if let Some(packed) = current_packed(&tx, id)? {
        let legacy = legacy_content.as_ref().ok_or_else(|| key_mismatch(id))?;
        let content = SealedContent::open(legacy, id, &packed)?;
        let updated_at: i64 = tx.query_row(
            "SELECT updated_at FROM private_content WHERE note_id = ?1",
            [id],
            |row| row.get(0),
        )?;
        put(&tx, id, &content.seal(&key, id)?, updated_at)?;
        stat.content = 1;
    }
    // 历史：一版一版搬，seq 与时间原样
    let revisions = {
        let mut stmt = tx.prepare("SELECT seq, content FROM private_revision WHERE note_id = ?1")?;
        stmt.query_map([id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if !revisions.is_empty() {
        let legacy = legacy_content.as_ref().ok_or_else(|| key_mismatch(id))?;
        for (seq, packed) in &revisions {
            let content = open_revision(legacy, id, *seq, packed)?;
            tx.execute(
                "UPDATE private_revision SET content = ?3 WHERE note_id = ?1 AND seq = ?2",
                params![id, seq, seal_revision(&key, id, *seq, &content)?],
            )?;
            stat.revisions += 1;
        }
    }
    // 图：这一张名下 enc=1 的行从旧 mediaKey 换到这张的钥匙（同一笔事务，解不开就整笔回滚）。
    // 正文用不上 contentKey 的张（1.2.9 之后新加的私密签）也可能有旧图，所以这一段单独判
    let pictures = crate::db::query::media::encrypted_for_note_conn(&tx, id)?;
    if !pictures.is_empty() {
        let Some(legacy) = legacy_media.as_ref() else {
            return Err(AppError::new(
                "MIGRATE_KEY_MISMATCH",
                format!("{id} 名下有 {} 张按旧媒体钥匙封着的图，封套里却没有那把钥匙", pictures.len()),
            ));
        };
        for row in &pictures {
            let raw = crypto::open_blob(legacy, &private::media_aad(&row.id), &row.bytes)?;
            crate::db::query::media::replace_bytes_conn(
                &tx,
                &row.id,
                &crypto::seal_blob(&key, &private::media_aad(&row.id), &raw)?,
                true,
            )?;
            stat.media += 1;
        }
    }
    // 键行最后写：从这一刻起"这张有键行"就等价于"上面三样都已经在它自己钥匙下"
    tx.execute(
        "INSERT INTO private_keys (note_id, key, created_at) VALUES (?1, ?2, ?3)",
        params![id, private::seal_note_key(&master, id, &key)?, now],
    )?;
    tx.commit()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    drop(conn);
    vault.reveal(id, key);
    if stat.content > 0 || stat.revisions > 0 || stat.media > 0 {
        log::info(
            "private",
            &format!(
                "{id} 从旧钥匙搬进自己的钥匙：{} 条正文、{} 个版本、{} 张图",
                stat.content, stat.revisions, stat.media
            ),
        );
    }
    Ok(stat)
}

fn key_row(conn: &Connection, id: &str) -> AppResult<Option<Vec<u8>>> {
    Ok(conn
        .query_row("SELECT key FROM private_keys WHERE note_id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?)
}

/// 这一张有没有"需要旧整层 contentKey 才解得开"的东西。调用点已经确认它没有键行，
/// 所以表里的正文行与历史行都还是旧形状
fn legacy_needing_content(conn: &Connection, id: &str) -> AppResult<bool> {
    if exists(conn, id)? {
        return Ok(true);
    }
    let revisions: i64 = conn.query_row(
        "SELECT COUNT(*) FROM private_revision WHERE note_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    Ok(revisions > 0)
}

fn key_mismatch(id: &str) -> AppError {
    AppError::new(
        "MIGRATE_KEY_MISMATCH",
        format!("{id} 有按旧整层钥匙封着的密文，可封套里没有那把钥匙——这两样对不上号，这次不开（硬搬会把它们永远解不开）"),
    )
}

/// 只有拿着 master 才做得到的两件全局活：拆旧封套那本整册 map、收编还明文摊着的私密便签。
/// 造出的行都是**旧形状**（整层 contentKey、无键行），每张真正进自己钥匙的时刻是它自己被
/// 揭开那一拍。两件都幂等（`INSERT OR IGNORE` + 只处理"行上还有字"的），断在中间重跑没事。
fn settle_legacy(db: &Db, vault: &PrivateVault, master: &[u8]) -> AppResult<()> {
    let envelope = private::read_envelope(vault.dir())?
        .ok_or_else(|| AppError::new("PRIVATE_MISSING", "私密层还没有设置"))?;
    let has_map = envelope.data.is_some();
    // 没活要干就别碰 `ensure_legacy_content_key`：那会往封套里补一把谁也不用的整层钥匙
    let residues = residue_count(db)?;
    if !has_map && residues == 0 {
        return Ok(());
    }
    // 补钥匙前先对账：库里已有旧形状的行而封套里没有 contentKey，说明那些行是别的钥匙封的，
    // 现造一把新的会把它们永远锁死（而"解不开"在界面上与"锁着"长得一模一样）
    if private::legacy_content_key(&envelope, master)?.is_none() && legacy_rows(db)? > 0 {
        return Err(AppError::new(
            "MIGRATE_KEY_MISMATCH",
            "封套里没有正文钥匙，可库里已经有逐条密文——这两样对不上号，这次不迁",
        ));
    }
    let key = private::ensure_legacy_content_key(vault, master)?;
    if has_map {
        migrate_map(db, vault, &envelope, master, &key)?;
    }
    adopt(db, &key)?;
    Ok(())
}

fn residue_count(db: &Db) -> AppResult<usize> {
    let conn = db.lock();
    let mut stmt = conn.prepare(RESIDUE_SQL)?;
    Ok(stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .len())
}

fn legacy_rows(db: &Db) -> AppResult<i64> {
    let conn = db.lock();
    // 只数**还没有键行**的那些：已经搬进自己钥匙的行用的是另一把钥匙，
    // 拿它们算"旧形状的行"会让每一次收编都误报成对不上号
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM private_content pc \
         WHERE NOT EXISTS (SELECT 1 FROM private_keys pk WHERE pk.note_id = pc.note_id)",
        [],
        |row| row.get(0),
    )?)
}

/// 明文残骸的判据：标着私密而行上还摊着字（标私密时私密层还没启用、从旧版导入来的那些）。
/// 不收它们就**永远**明文躺在 mini.db 里——蒙版只挡住界面，拿任何 sqlite 工具打开都看得到。
const RESIDUE_SQL: &str = "SELECT id, title, body, content_type, items_json, timeline_json, \
     tags_json FROM stickies WHERE private = 1 AND (title <> '' OR body <> '' \
     OR items_json <> '[]' OR timeline_json <> '[]' OR tags_json <> '[]')";

/// 收编这些残骸：封进表、行抹成占位，**不续写 updatedAt、不记历史**（那是形状搬运）。
/// 判据只看行上有没有字：表里已经有而行上还有字，是上一次断在两步之间，表里那份才作数，
/// 行上的字照样抹掉。`content_key` 是旧形状那把整层钥匙——收进来的行没有键行，
/// 等每一张第一次被揭开时再搬进它自己的钥匙。返回封进表的张数。
pub fn adopt(db: &Db, content_key: &[u8]) -> AppResult<usize> {
    let conn = db.lock();
    let mut stmt = conn.prepare(RESIDUE_SQL)?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            SealedContent {
                title: row.get(1)?,
                body: row.get(2)?,
                content_type: row.get(3)?,
                items_json: row.get(4)?,
                timeline_json: row.get(5)?,
                tags_json: row.get(6)?,
            },
        ))
    })?;
    let targets = rows.collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if targets.is_empty() {
        return Ok(0);
    }
    let now = crate::db::query::sticky::now_ms();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    let mut sealed = 0usize;
    for (id, content) in &targets {
        // 表里那份已经是真身时别拿行上的字去覆盖它（残骸那条路）
        if !exists(&tx, id)? {
            let packed = content.seal(content_key, id)?;
            tx.execute(
                "INSERT INTO private_content (note_id, content, updated_at) VALUES (?1, ?2, ?3)",
                params![id, packed, now],
            )?;
            sealed += 1;
        }
        blank_row(&tx, id)?;
    }
    tx.commit()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    log::info(
        "private",
        &format!("收编 {} 张没进套的私密便签（{} 张是真身搬家，行改成空占位）", targets.len(), sealed),
    );
    Ok(sealed)
}

/// v1 整册 map 的一条（当年那份 JSON：`id → 内容 + 历史`，字段 camelCase）
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct LegacyEntry {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    items: Vec<StickyItem>,
    #[serde(default)]
    timeline: Vec<TimelineEntry>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    revisions: Vec<LegacyRevision>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct LegacyRevision {
    seq: i64,
    created_at: i64,
    content: LegacyEntry,
}

/// 一次 v1 迁移的账
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Migrated {
    /// 搬进去的正文条数
    pub notes: usize,
    /// 搬进去的历史版本条数
    pub revisions: usize,
    /// 旧 map 里有、库里却没有对应便签行的那些（直接丢，不留孤儿）
    pub dropped: usize,
}

/// 把 v1 封套里那份整册 map 拆成逐条密文（写的是**旧形状**：整层 contentKey、无键行）。
/// 幂等，全部落定之后才改写封套（`private::finish_v1_migration`：先留底再写 v2），
/// 顺序反过来的话中间断一次就是"旧 map 没了、行还没搬完"。
fn migrate_map(
    db: &Db,
    vault: &PrivateVault,
    envelope: &private::Envelope,
    master: &[u8],
    content_key: &[u8],
) -> AppResult<()> {
    let Some(map_json) = private::legacy_map(envelope, master)? else {
        return Ok(());
    };
    let map: std::collections::BTreeMap<String, LegacyEntry> =
        serde_json::from_str(&map_json).map_err(|e| {
            AppError::new("PRIVATE_DATA", format!("旧封套里的内容形状不认识：{e}"))
        })?;
    let now = crate::db::query::sticky::now_ms();
    let mut report = Migrated::default();
    {
        let conn = db.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
        for (id, entry) in &map {
            // 只对得上号的才搬：便签行没了的（硬删漏下的孤儿）与已经不是私密的
            // （翻面时旧实现没摘掉条目留下的那份）都直接丢，搬过去就是再造一次孤儿
            let row_state: Option<(i64,)> = tx
                .query_row(
                    "SELECT private FROM stickies WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?,)),
                )
                .optional()?;
            match row_state {
                None | Some((0,)) => {
                    report.dropped += 1;
                    continue;
                }
                Some((_,)) => {}
            }
            let content = to_sealed(entry);
            let packed = content.seal(content_key, id)?;
            report.notes += tx.execute(
                "INSERT OR IGNORE INTO private_content (note_id, content, updated_at) \
                 VALUES (?1, ?2, ?3)",
                params![id, packed, now],
            )?;
            for rev in &entry.revisions {
                let packed = seal_revision(content_key, id, rev.seq, &to_sealed(&rev.content))?;
                report.revisions += tx.execute(
                    "INSERT OR IGNORE INTO private_revision (note_id, seq, content, created_at) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![id, rev.seq, packed, rev.created_at],
                )?;
            }
        }
        tx.commit()
            .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    }
    private::finish_v1_migration(vault)?;
    log::info(
        "private",
        &format!(
            "旧封套迁移完成：{} 条正文、{} 个历史版本进表（丢弃 {} 条没有对应便签行的）",
            report.notes, report.revisions, report.dropped
        ),
    );
    Ok(())
}

fn to_sealed(entry: &LegacyEntry) -> SealedContent {
    SealedContent {
        title: entry.title.clone(),
        body: entry.body.clone(),
        content_type: if entry.content_type.is_empty() {
            "text".to_string()
        } else {
            entry.content_type.clone()
        },
        items_json: json_or_blank(&entry.items),
        timeline_json: json_or_blank(&entry.timeline),
        tags_json: json_or_blank(&entry.tags),
    }
}

fn json_or_blank<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| BLANK_JSON.to_string())
}
