// media 命令 — 图片进出唯一的通道。
//  · **id 由 Rust 生成**：前端传的 id 能撞车也能伪造，而正文里 `media://<id>` 是这张图唯一凭据。
//  · 私密便签的图用**那张便签自己的钥匙**加密（跟正文同一条钥匙，见迁移 0012）；
//    私密层没配置时按明文直通——与正文口径一致。
//  · 字节走 base64（JSON 装不了裸字节）；粘贴是一次性动作，不在热路径。
// 全库不用外键，硬删便签/清算回收站都要显式带走 media 行（见 entity.rs 与 trash.rs）。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::data::private::{self, PrivateVault};
use crate::data::crypto;
use crate::db::pool::Db;
use crate::db::query::{media, private_note, sticky};
use crate::support::{clock, log};
use crate::support::error::{AppError, AppResult};
use crate::support::id;

use super::run_db;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInput {
    pub note_id: String,
    pub mime: String,
    pub data_base64: String,
    pub width: i64,
    pub height: i64,
    /// 这张便签此刻私不私密。**不是**"要不要加密"的开关（还要看私密层配没配置），也不最终算数：
    /// 密级以库行标记为准，这一份只在"便签还没落库"时兜底（见 `seal_for`）。
    pub private: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    pub id: String,
    pub note_id: String,
    pub mime: String,
    pub width: i64,
    pub height: i64,
    /// true = 库里这行是密文（要解锁才读得出来）
    pub enc: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaBytes {
    pub mime: String,
    pub data_base64: String,
}

/// 只挡明显离谱的宽高（0、负数、四万像素）：系统边界，越界就是哪一侧算错了
fn check_shape(width: i64, height: i64) -> AppResult<()> {
    if !(1..=40_000).contains(&width) || !(1..=40_000).contains(&height) {
        return Err(AppError::new(
            "MEDIA_SHAPE",
            format!("图片尺寸 {width}x{height} 不合理"),
        ));
    }
    Ok(())
}

/// 这张图按什么密级落盘。**以库行标记为准**，`input.private` 只在便签还没落库（250ms 去抖没跑）时兜底。
/// 副本跨窗可能慢几毫秒，按副本会把私密图的字节写成明文；反过来（库行公开、副本私密）只是暂时解不开。
fn seal_for(db: &Db, note_id: &str, client_private: bool) -> AppResult<bool> {
    match sticky::private_flag(db, note_id)? {
        Some(row_private) => {
            if row_private != client_private {
                // 说得出才对得上账：两边不一致就是刚翻面还没同步，按库行那个
                log::info(
                    "media",
                    &format!("{note_id}：密级前端说 {client_private}、库行说 {row_private}，按库行"),
                );
            }
            Ok(row_private)
        }
        None => Ok(client_private),
    }
}

#[tauri::command]
pub async fn media_save(
    db: State<'_, Db>,
    vault: State<'_, PrivateVault>,
    input: MediaInput,
) -> AppResult<MediaMeta> {
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    run_db(db, move |db| {
        check_shape(input.width, input.height)?;
        // 越界的图先按 base64 的**字符串**长度拦下：4 个字符解出 3 个字节，向上估一次就够，
        // 真正的判据还是下面那句 `media::check`。省的是"一张注定不收的图先解成 6.8 MB"那一趟
        if input.data_base64.len().div_ceil(4) * 3 > media::MAX_BYTES {
            return Err(AppError::new(
                "MEDIA_TOO_BIG",
                format!(
                    "这张图太大，超过单张 {} MB 上限",
                    media::MAX_BYTES / 1024 / 1024
                ),
            ));
        }
        let raw = B64.decode(&input.data_base64)
            .map_err(|e| AppError::new("MEDIA_DECODE", format!("图片字节解不出来：{e}")))?;
        let existing = media::count_for_note(db, &input.note_id)?;
        media::check(&input.mime, raw.len(), existing)?;

        let media_id = id::media();
        let wants_private = seal_for(db, &input.note_id, input.private)?;
        // 封套读不出来时也不许把这张的图落成明文：明文的字节 + 行上"私密"那句标记，
        // 比这条存不进去难发现得多
        if wants_private && let Some(error) = vault.damage() {
            return Err(error);
        }
        let seal = wants_private && vault.is_configured();
        let (bytes, enc) = if seal {
            // 这一张没揭开就到这里拿到 PRIVATE_LOCKED：宁可不存，也不把私密图写成明文
            let key = private_note::image_key(&vault, &input.note_id)?;
            let packed = crypto::seal_blob(&key, &private::media_aad(&media_id), &raw)?;
            (packed, true)
        } else {
            (raw, false)
        };
        let row = media::MediaRow {
            id: media_id.clone(),
            note_id: input.note_id.clone(),
            mime: input.mime.clone(),
            bytes,
            enc,
            width: input.width,
            height: input.height,
            created_at: clock::now_ms(),
        };
        media::save(db, &row)?;
        Ok(MediaMeta {
            id: media_id,
            note_id: input.note_id,
            mime: input.mime,
            width: input.width,
            height: input.height,
            enc,
        })
    })
    .await
}

/// 取一张图的字节。None = 库里没这行（图被删了，或正文里的引用来自旧库）
#[tauri::command]
pub async fn media_get(
    db: State<'_, Db>,
    vault: State<'_, PrivateVault>,
    id: String,
) -> AppResult<Option<MediaBytes>> {
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    run_db(db, move |db| {
        let Some(row) = media::get(db, &id)? else {
            return Ok(None);
        };
        let bytes = if row.enc {
            // 图跟正文同一条钥匙：这一张没揭开就读不出这张图（蒙版下面不该有任何字节）
            let key = private_note::image_key(&vault, &row.note_id)?;
            crypto::open_blob(&key, &private::media_aad(&row.id), &row.bytes)?
        } else {
            row.bytes
        };
        Ok(Some(MediaBytes {
            mime: row.mime,
            data_base64: B64.encode(bytes),
        }))
    })
    .await
}

/// 删一张图（正文里删掉那句引用时配套调用）。返回是不是真删了一行——
/// 引用已经是死的不算错
#[tauri::command]
pub async fn media_delete(db: State<'_, Db>, id: String) -> AppResult<bool> {
    let db = db.inner().clone();
    run_db(db, move |db| Ok(media::delete(db, &id)? > 0)).await
}

/// 私密标记翻了：用那张便签自己的钥匙把名下图逐行重过密文（明文↔密文）。私密层没配置就一行不动。
/// 翻回公开时这一发必须**赶在** `sticky_upsert` 之前——那一拍会把密文行与键行一起摘掉，
/// 键行先没了这些图就再也解不开。
#[tauri::command]
pub async fn media_set_private(
    db: State<'_, Db>,
    vault: State<'_, PrivateVault>,
    note_id: String,
    private: bool,
) -> AppResult<usize> {
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    run_db(db, move |db| {
        if !vault.is_configured() {
            return Ok(0);
        }
        let key = private_note::image_key(&vault, &note_id)?;
        let conn = db.lock();
        // 一把事务：某一行封不动就整笔回滚，绝不留下"几行密文几行明文"的半摊——
        // 那种行前端已经翻过去了，剩下的明文再没人来抹
        let tx = conn.unchecked_transaction()?;
        let mut changed = 0usize;
        for row in media::list_for_note_conn(&tx, &note_id)? {
            let next = match (private, row.enc) {
                (true, false) => Some((crypto::seal_blob(&key, &private::media_aad(&row.id), &row.bytes)?, true)),
                (false, true) => Some((crypto::open_blob(&key, &private::media_aad(&row.id), &row.bytes)?, false)),
                // 已经是要的形状：不重写（重写一次就多一次 nonce，也白读一次密钥）
                _ => None,
            };
            if let Some((bytes, enc)) = next {
                media::replace_bytes_conn(&tx, &row.id, &bytes, enc)?;
                changed += 1;
            }
        }
        tx.commit()?;
        Ok(changed)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    fn input(id: &str, private: bool) -> crate::db::models::StickyInput {
        crate::db::models::StickyInput {
            id: id.to_string(),
            title: String::new(),
            body: String::new(),
            content_type: "text".into(),
            items: Vec::new(),
            timeline: Vec::new(),
            tags: Vec::new(),
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

    /// 前端那份副本说"不私密"，库行说"私密" → 按库行走，图不许写成明文
    #[test]
    fn 密级以库行为准_副本落后了也不写明文() {
        let db = db();
        let vault = crate::data::private::PrivateVault::disabled("media");
        sticky::upsert(&db, &vault, input("p1", true)).expect("建私密便签");
        assert!(seal_for(&db, "p1", false).expect("判密级"), "库行说私密就得封");
        assert!(seal_for(&db, "p1", true).expect("判密级"), "两边一致当然照库行");
    }

    /// 新建便签还没落库（250ms 去抖没跑），库里没这行 —— 这时只有前端那份可用，`input.private` 唯一用场
    #[test]
    fn 便签还没落库时按前端那份兜底() {
        let db = db();
        let vault = crate::data::private::PrivateVault::disabled("media");
        assert!(seal_for(&db, "还没建的那张", true).expect("判密级"));
        assert!(!seal_for(&db, "还没建的那张", false).expect("判密级"));
        // 公开便签是常态：库行说公开、副本说私密也不封（不对称的理由见 `seal_for`）
        sticky::upsert(&db, &vault, input("s1", false)).expect("建公开便签");
        assert!(!seal_for(&db, "s1", true).expect("判密级"));
    }
}
