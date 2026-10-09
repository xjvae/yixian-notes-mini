// media 命令 — 图片进出唯一的通道。
//
// 三条口径：
//  · **id 由 Rust 生成**（support::id::media）：前端传进来的 id 能撞车也能伪造，
//    而正文里那个 `media://<id>` 就是这张图唯一的凭据；
//  · 私密便签的图用封套里的**媒体密钥**加密（data/private.rs）。"私密层没配置"时
//    按明文直通——与正文那条口径一字不差（见 private-backend.ts 头注释：
//    没启用时"私密"只是个标记，内容照旧明文在主库）；
//  · 字节走 base64：JSON 通道装不了裸字节。5 MB 的图 → ~6.7 MB JSON，
//    而粘贴是一次性动作，不在热路径上。
//
// 删同步没有"级联"可依赖（全库不用外键）：删便签的硬删路径与回收站清算都要显式
// 带走 media 行，见 entity.rs 与 trash.rs。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::data::private::PrivateVault;
use crate::data::{crypto, private};
use crate::db::pool::Db;
use crate::db::query::media;
use crate::support::clock;
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
    /// 这张便签此刻私不私密。**不是**"要不要加密"的开关——还要看私密层配没配置，
    /// 那条判断留在服务端，前端说不算
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

/// 宽高是给渲染层按比例占位用的。前端从 Image 量来，这里只挡明显离谱的
/// （0、负数、四万像素）：这是系统边界，越界就是哪一侧算错了
fn check_shape(width: i64, height: i64) -> AppResult<()> {
    if !(1..=40_000).contains(&width) || !(1..=40_000).contains(&height) {
        return Err(AppError::new(
            "MEDIA_SHAPE",
            format!("图片尺寸 {width}x{height} 不合理"),
        ));
    }
    Ok(())
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
        let raw = B64.decode(&input.data_base64)
            .map_err(|e| AppError::new("MEDIA_DECODE", format!("图片字节解不出来：{e}")))?;
        let existing = media::count_for_note(db, &input.note_id)?;
        media::check(&input.mime, raw.len(), existing)?;

        let media_id = id::media();
        let seal = input.private && vault.is_configured();
        let (bytes, enc) = if seal {
            // 没解锁就到这里会拿到 PRIVATE_LOCKED：宁可不存，也不把私密图写成明文
            let key = private::media_key(&vault)?;
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
            let key = private::media_key(&vault)?;
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

/// 便签的私密标记翻了：把它名下的图逐行重过一遍密文（明文→密文、密文→明文）。
/// 私密层没配置就一行都不动（那时根本没有"加密"这回事）。
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
        let key = private::media_key(&vault)?;
        let mut changed = 0usize;
        for row in media::list_for_note(db, &note_id)? {
            let next = match (private, row.enc) {
                (true, false) => Some((crypto::seal_blob(&key, &private::media_aad(&row.id), &row.bytes)?, true)),
                (false, true) => Some((crypto::open_blob(&key, &private::media_aad(&row.id), &row.bytes)?, false)),
                // 已经是要的形状：不重写（重写一次就多一次 nonce，也白读一次密钥）
                _ => None,
            };
            if let Some((bytes, enc)) = next {
                media::replace_bytes(db, &row.id, &bytes, enc)?;
                changed += 1;
            }
        }
        Ok(changed)
    })
    .await
}
