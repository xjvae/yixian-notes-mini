// 组合查询 — 成员关系的唯一住址是 stickies.group_id；组行删了成员自动散着（读侧认不到组就当散）。
// 建组的入口只有一个：**把一张拖到另一张上**（`merge_into`）。设置/菜单里没有"新建组合"
// 那种空表单——一叠至少要有两张才立得住，而拖这个动作天然保证了这一点。

use rusqlite::{params, OptionalExtension};

use crate::db::models::GroupRow;
use crate::db::pool::Db;
use crate::support::error::{AppError, AppResult};

/// 组合名是唯一一处"给人起的短标签"，口径收在这里：去首尾空白、空回落到
/// 「未命名组合」、按**字符数**截到 40（与便签标题同值）。
/// 截断而不是报错：名字是标签不是正文，多打的那几个字丢掉不心疼，
/// 报错却让改个名多一次往返。输入框那边还有 `maxLength` 挡着。
pub fn normalize_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "未命名组合".to_string();
    }
    trimmed.chars().take(40).collect::<String>()
}

/// 改组合名。组不存在要明说（"移进组合"的菜单在别的窗里，那边删掉这张组、
/// 这扇叠窗还开着是可能的，静默写成 0 行就是"改了没生效"查不到）
pub fn rename(db: &Db, gid: &str, raw: &str) -> AppResult<()> {
    let name = normalize_name(raw);
    let now = crate::db::query::sticky::now_ms();
    let conn = db.lock();
    let changed = conn.execute(
        "UPDATE groups SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![gid, name, now],
    )?;
    if changed == 0 {
        return Err(AppError::new("GROUP_NOT_FOUND", "这个组合已经不在了"));
    }
    Ok(())
}

/// 收起 / 恢复一叠的标题栏形态。`groups.collapsed` 这一列今天终于有了读者。
///
/// 收起那一刻顺带把**展开尺寸**存进 `width/height`：窗自身的记忆走 `window_state`
/// （收起期间它记的就是那条 62 高的栏），所以"恢复成多大"必须有个不跟着窗变的地方，
/// 组行这一份正好是开窗时的出生尺寸 —— 一处存两处用，不另立字段。
/// `expand` 给 None 就是只翻状态（恢复时前端不用报尺寸，行里那份本来就是展开值）。
pub fn set_collapsed(
    db: &Db,
    gid: &str,
    collapsed: bool,
    expand: Option<(i64, i64)>,
) -> AppResult<()> {
    let now = crate::db::query::sticky::now_ms();
    let conn = db.lock();
    let changed = match expand {
        Some((width, height)) => conn.execute(
            "UPDATE groups SET collapsed = ?2, width = ?3, height = ?4, updated_at = ?5 \
             WHERE id = ?1",
            params![gid, collapsed, width, height, now],
        )?,
        None => conn.execute(
            "UPDATE groups SET collapsed = ?2, updated_at = ?3 WHERE id = ?1",
            params![gid, collapsed, now],
        )?,
    };
    if changed == 0 {
        return Err(AppError::new("GROUP_NOT_FOUND", "这个组合已经不在了"));
    }
    Ok(())
}

/// 贴边 / 解除贴边。`edge` 只认那四条（前端算落点时也是这四条）：认不出的值一律
/// 按"没贴"处理并清空，别留一个 `docked=1, dock_edge='左'` 的半吊子状态——
/// 那种行开机时会摆出一块不在任何边上的细丝。
pub fn set_dock(db: &Db, gid: &str, docked: bool, edge: Option<&str>) -> AppResult<()> {
    const EDGES: [&str; 4] = ["left", "right", "top", "bottom"];
    let edge = match (docked, edge) {
        (true, Some(edge)) if EDGES.contains(&edge) => Some(edge),
        _ => None,
    };
    // 认不出边就当没贴（写回的是**这个**值，不是传进来的那个）：留一个
    // `docked=1, dock_edge=NULL` 的行，开机前端会拿默认那条边摆出一块不在边上的细丝
    let docked = edge.is_some();
    let now = crate::db::query::sticky::now_ms();
    let conn = db.lock();
    let changed = conn.execute(
        "UPDATE groups SET docked = ?2, dock_edge = ?3, updated_at = ?4 WHERE id = ?1",
        params![gid, docked as i64, edge, now],
    )?;
    if changed == 0 {
        return Err(AppError::new("GROUP_NOT_FOUND", "这个组合已经不在了"));
    }
    Ok(())
}

pub fn list(db: &Db) -> AppResult<Vec<GroupRow>> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, color, collapsed, docked, dock_edge, x, y, width, height, \
         created_at, updated_at \
         FROM groups ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(GroupRow {
                id: row.get("id")?,
                name: row.get("name")?,
                color: row.get("color")?,
                collapsed: row.get::<_, i64>("collapsed")? != 0,
                docked: row.get::<_, i64>("docked")? != 0,
                dock_edge: row.get("dock_edge")?,
                x: row.get("x")?,
                y: row.get("y")?,
                width: row.get("width")?,
                height: row.get("height")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn exists(db: &Db, id: &str) -> AppResult<bool> {
    let conn = db.lock();
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM groups WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// 单组读。叠窗开窗路径取几何用。
pub fn get(db: &Db, id: &str) -> AppResult<Option<GroupRow>> {
    let conn = db.lock();
    conn.query_row(
        "SELECT id, name, color, collapsed, docked, dock_edge, x, y, width, height, \
         created_at, updated_at \
         FROM groups WHERE id = ?1",
        [id],
        |row| {
            Ok(GroupRow {
                id: row.get("id")?,
                name: row.get("name")?,
                color: row.get("color")?,
                collapsed: row.get::<_, i64>("collapsed")? != 0,
                docked: row.get::<_, i64>("docked")? != 0,
                dock_edge: row.get("dock_edge")?,
                x: row.get("x")?,
                y: row.get("y")?,
                width: row.get("width")?,
                height: row.get("height")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// 成员归属：写 stickies.group_id。Some 必须指向存在的组（认不到就拒，防手滑
/// 把便签塞进幽灵组）——指向已删组本是无害态，但作为**写入口**必须严格。
pub fn set_member(db: &Db, id: &str, group_id: Option<&str>) -> AppResult<bool> {
    if let Some(gid) = group_id
        && !exists(db, gid)?
    {
        return Err(crate::support::error::AppError::new(
            "GROUP_MISSING",
            format!("组合 {gid} 不存在"),
        ));
    }
    let conn = db.lock();
    let changed = conn.execute(
        "UPDATE stickies SET group_id = ?2, updated_at = ?3 WHERE id = ?1 AND deleted = 0",
        params![id, group_id, crate::db::query::sticky::now_ms()],
    )?;
    Ok(changed > 0)
}

/// 「把 source 拖到 target 上松手」的产物：并进了哪一叠，那一叠是不是这次新建的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    pub group_id: String,
    pub created: bool,
}

/// 读一张的行——只取并组要用的那几列。
///
/// 为什么不用 `sticky::get`：那条会再 `db.lock()` 一次，而我们已经在同一把锁里，
/// 同线程重入就是自锁。
struct Peeked {
    group_id: Option<String>,
    title: String,
    x: Option<i64>,
    y: Option<i64>,
    width: Option<i64>,
    height: Option<i64>,
}

fn peek(conn: &rusqlite::Connection, id: &str) -> AppResult<Option<Peeked>> {
    let row = conn
        .query_row(
            "SELECT group_id, title, x, y, width, height FROM stickies \
             WHERE id = ?1 AND deleted = 0",
            [id],
            |row| {
                Ok(Peeked {
                    group_id: row.get("group_id")?,
                    title: row.get("title")?,
                    x: row.get("x")?,
                    y: row.get("y")?,
                    width: row.get("width")?,
                    height: row.get("height")?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// 拖拽进组（把 source 拖到 target 上松手）。两条分支：
///  · target 已经在某一叠里 → source 直接进那一叠，不新建；
///  · target 还散着 → 就地建一叠收进两张。组名取 target 的标题（空则「未命名组合」），
///    摆位**抄 target 记着的那一份**——叠窗开出来要正盖在原来那张纸上，换个地方落
///    就是用户眼里的"我一松手它跑了"。
///
/// 同一张不许并到自己身上；任一张不存在/已删都报错，由调用方原样退回给用户。
/// 新组 id 由调用方（`float::gen_group_id`）生成后传进来，这里只管用——只有真要新建
/// 那一支才用得到，并进已有叠时忽略。
pub fn merge_into(
    db: &Db,
    source_id: &str,
    target_id: &str,
    new_group_id: &str,
) -> AppResult<Merged> {
    if source_id == target_id {
        return Err(AppError::new(
            "MERGE_INTO_SELF",
            "不能把一张便签并进它自己",
        ));
    }
    let conn = db.lock();
    let target = peek(&conn, target_id)?.ok_or_else(|| {
        AppError::new("STICKY_MISSING", "要并入的那张便签已经不在了")
    })?;
    if peek(&conn, source_id)?.is_none() {
        return Err(AppError::new("STICKY_MISSING", "被拖的那张便签已经不在了"));
    }
    let now = crate::db::query::sticky::now_ms();
    if let Some(gid) = target.group_id {
        conn.execute(
            "UPDATE stickies SET group_id = ?2, updated_at = ?3 WHERE id = ?1 AND deleted = 0",
            params![source_id, gid, now],
        )?;
        return Ok(Merged {
            group_id: gid,
            created: false,
        });
    }
    // 名字口径与改名同一条（建组时取的是第一张便签的标题，也可能空/超长）
    let name = normalize_name(&target.title);
    conn.execute(
        "INSERT INTO groups (id, name, color, collapsed, x, y, width, height, created_at, updated_at)
         VALUES (?1, ?2, NULL, 0, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![new_group_id, name, target.x, target.y, target.width, target.height, now],
    )?;
    for id in [target_id, source_id] {
        conn.execute(
            "UPDATE stickies SET group_id = ?2, updated_at = ?3 WHERE id = ?1 AND deleted = 0",
            params![id, new_group_id, now],
        )?;
    }
    Ok(Merged {
        group_id: new_group_id.to_string(),
        created: true,
    })
}

/// 空组自动清：删掉没有任何未删成员的组行。返回清掉几组。
pub fn prune_empty(db: &Db) -> AppResult<usize> {
    let conn = db.lock();
    conn.execute(
        "DELETE FROM groups WHERE id NOT IN (
            SELECT DISTINCT group_id FROM stickies
            WHERE group_id IS NOT NULL AND deleted = 0
        )",
        [],
    )?;
    Ok(conn.changes() as usize)
}

/// 开机要拉起的叠窗：有 ≥1 张 floating 成员的组。
pub fn stacks_to_restore(db: &Db) -> AppResult<Vec<String>> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT g.id FROM groups g
         JOIN stickies s ON s.group_id = g.id
         WHERE s.floating = 1 AND s.deleted = 0
         ORDER BY g.created_at ASC",
    )?;
    let ids = stmt.query_map([], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::StickyInput;
    use crate::db::query::sticky;
    use rusqlite::Connection;

    fn db_with_schema() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    fn sticky(id: &str, group_id: Option<&str>) -> StickyInput {
        StickyInput {
            id: id.to_string(),
            title: format!("便签{id}"),
            body: String::new(),
            content_type: "text".into(),
            items: Vec::new(),
            timeline: Vec::new(),
            tags: Vec::new(),
            theme: "yellow".into(),
            pinned: true,
            floating: true,
            collapsed: false,
            is_private: false,
            group_id: group_id.map(str::to_string),
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

    fn make_group(db: &Db, id: &str) {
        db.lock()
            .execute(
                "INSERT INTO groups (id, name, created_at, updated_at) VALUES (?1, '组', 1, 1)",
                [id],
            )
            .expect("建组");
    }

    #[test]
    fn 改名走同一条名字口径() {
        let db = db_with_schema();
        make_group(&db, "g1");

        rename(&db, "g1", "  买菜的那一叠  ").expect("改名");
        let got = list(&db).expect("清单");
        assert_eq!(got[0].name, "买菜的那一叠", "首尾空白要去掉");

        rename(&db, "g1", "   ").expect("空名");
        assert_eq!(list(&db).expect("清单")[0].name, "未命名组合", "空的回落占位");

        rename(&db, "g1", &"字".repeat(60)).expect("超长");
        assert_eq!(
            list(&db).expect("清单")[0].name.chars().count(),
            40,
            "按字符数截到 40（与便签标题同值，不是按字节）"
        );
    }

    #[test]
    fn 改名对象不存在的组要报错而不是静默() {
        let db = db_with_schema();
        let err = rename(&db, "ghost", "随便").expect_err("必须拒");
        assert_eq!(err.code, "GROUP_NOT_FOUND");
    }

    /// 贴边状态：认得的边才落，认不出的一律按"没贴"算。
    /// 留一个 `docked=1, dock_edge='左'` 的半吊子行，开机就会摆出一块不在任何边上的细丝。
    #[test]
    fn 贴边只认那四条_其余按没贴() {
        let db = db_with_schema();
        make_group(&db, "g1");

        set_dock(&db, "g1", true, Some("left")).expect("贴左");
        let row = get(&db, "g1").expect("读").expect("在");
        assert!(row.docked && row.dock_edge.as_deref() == Some("left"));

        set_dock(&db, "g1", true, Some("左")).expect("认不出的边");
        let row = get(&db, "g1").expect("读").expect("在");
        assert!(!row.docked && row.dock_edge.is_none(), "认不出 = 没贴，两列一起清");

        set_dock(&db, "g1", true, Some("bottom")).expect("贴底");
        set_dock(&db, "g1", false, Some("bottom")).expect("解除");
        let row = get(&db, "g1").expect("读").expect("在");
        assert!(!row.docked, "解除只翻状态");
        assert!(row.dock_edge.is_none(), "解除要把边一起清掉，别留残值");

        let err = set_dock(&db, "ghost", true, Some("left")).expect_err("组不在必须拒");
        assert_eq!(err.code, "GROUP_NOT_FOUND");
    }

    #[test]
    fn 移进_移出_空组自动清() {
        let db = db_with_schema();
        make_group(&db, "g1");
        make_group(&db, "g2");
        sticky::upsert(&db, sticky("s1", None)).expect("写 s1");

        assert!(set_member(&db, "s1", Some("g1")).expect("移进"));
        assert!(exists(&db, "g1").expect("组在"));
        assert_eq!(prune_empty(&db).expect("清"), 1, "g2 是空组被清");
        assert!(!exists(&db, "g2").expect("g2 没了"));
        assert!(exists(&db, "g1").expect("g1 有成员还在"));

        set_member(&db, "s1", None).expect("移出");
        assert_eq!(prune_empty(&db).expect("清"), 1, "g1 空了被清");
        assert!(!exists(&db, "g1").expect("g1 没了"));
    }

    #[test]
    fn 移进不存在的组被拒() {
        let db = db_with_schema();
        sticky::upsert(&db, sticky("s1", None)).expect("写");
        let err = set_member(&db, "s1", Some("ghost")).expect_err("必须拒");
        assert_eq!(err.code, "GROUP_MISSING");
    }

    #[test]
    fn 已删成员不算组员_空组随之清() {
        let db = db_with_schema();
        make_group(&db, "g1");
        sticky::upsert(&db, sticky("s1", Some("g1"))).expect("写");
        sticky::delete(&db, "s1", false).expect("软删");
        assert_eq!(prune_empty(&db).expect("清"), 1, "成员全删的组被清");
    }

    #[test]
    fn 叠窗恢复清单_只含有浮窗成员的组() {
        let db = db_with_schema();
        make_group(&db, "g1");
        make_group(&db, "g2");
        sticky::upsert(&db, sticky("s1", Some("g1"))).expect("写 s1（浮窗）");
        let mut wall = sticky("s2", Some("g2"));
        wall.floating = false; // 墙存量（导入摊回前）
        sticky::upsert(&db, wall).expect("写 s2");
        assert_eq!(stacks_to_restore(&db).expect("清单"), vec!["g1"]);
    }

    /// 拖到一张散着的便签上：就地立一叠，收两张，组名取**被拖到的那张**的标题，
    /// 摆位抄它记着的那一份（叠窗要正盖在原来那张纸上）。
    #[test]
    fn 拖到散着的张上_立一叠并抄它的标题与摆位() {
        let db = db_with_schema();
        let mut target = sticky("t", None);
        target.title = "买菜的清单".into();
        target.x = Some(300);
        target.y = Some(200);
        target.width = Some(320);
        target.height = Some(300);
        sticky::upsert(&db, target).expect("写 target");
        sticky::upsert(&db, sticky("s", None)).expect("写 source");

        let merged = merge_into(&db, "s", "t", "g-new").expect("并组");
        assert_eq!(
            merged,
            Merged {
                group_id: "g-new".into(),
                created: true,
            }
        );
        let group = get(&db, "g-new").expect("读组").expect("组在");
        assert_eq!(group.name, "买菜的清单");
        assert_eq!((group.x, group.y), (Some(300), Some(200)));
        assert_eq!((group.width, group.height), (Some(320), Some(300)));
        for id in ["s", "t"] {
            let row = sticky::get(&db, id).expect("读").expect("在");
            assert_eq!(row.group_id.as_deref(), Some("g-new"), "{id} 该在这一叠里");
        }
    }

    /// 拖到已经在一叠里的某张上：进**那一叠**，不新建组行（组数不变）。
    #[test]
    fn 拖到已成叠的张上_进那一叠不新建() {
        let db = db_with_schema();
        make_group(&db, "g1");
        sticky::upsert(&db, sticky("in", Some("g1"))).expect("写组员");
        sticky::upsert(&db, sticky("s", None)).expect("写 source");

        let merged = merge_into(&db, "s", "in", "g-should-not-exist").expect("并组");
        assert_eq!(
            merged,
            Merged {
                group_id: "g1".into(),
                created: false,
            }
        );
        assert_eq!(list(&db).expect("清单").len(), 1, "不许多建一行组");
        assert!(!exists(&db, "g-should-not-exist").expect("查"), "新 id 不该被用上");
        assert_eq!(
            sticky::get(&db, "s")
                .expect("读")
                .expect("在")
                .group_id
                .as_deref(),
            Some("g1")
        );
    }

    /// 标题为空 → 组名给个不骗人的默认；没摆过位 → 组行坐标也是 NULL（不瞎猜位置）
    #[test]
    fn 空标题与没摆过位也照样能并() {
        let db = db_with_schema();
        let mut target = sticky("t", None);
        target.title = "   ".into();
        sticky::upsert(&db, target).expect("写");
        sticky::upsert(&db, sticky("s", None)).expect("写");
        merge_into(&db, "s", "t", "g2").expect("并组");
        let group = get(&db, "g2").expect("读").expect("在");
        assert_eq!(group.name, "未命名组合");
        assert_eq!((group.x, group.y, group.width, group.height), (None, None, None, None));
    }

    /// 三种不该并的情况：自己并自己、目标不在、被拖的不在。报得出来，界面才有的说
    #[test]
    fn 并组的三条拒绝() {
        let db = db_with_schema();
        sticky::upsert(&db, sticky("t", None)).expect("写");
        let err = merge_into(&db, "t", "t", "g").expect_err("自己不能并自己");
        assert_eq!(err.code, "MERGE_INTO_SELF");
        let err = merge_into(&db, "s", "gone", "g").expect_err("目标不在");
        assert_eq!(err.code, "STICKY_MISSING");
        let err = merge_into(&db, "gone", "t", "g").expect_err("被拖的不在");
        assert_eq!(err.code, "STICKY_MISSING");
        assert_eq!(list(&db).expect("清单").len(), 0, "拒绝的三条不许留下组行");
    }

    /// 并组后被软删的那张不再算组员：两张都删光时 `prune_empty` 要能把空组带走
    #[test]
    fn 并进去的张被删光_空组随之清() {
        let db = db_with_schema();
        sticky::upsert(&db, sticky("t", None)).expect("写");
        sticky::upsert(&db, sticky("s", None)).expect("写");
        merge_into(&db, "s", "t", "g").expect("并组");
        sticky::delete(&db, "s", false).expect("删 s");
        assert_eq!(prune_empty(&db).expect("清"), 0, "还剩 target，不该清");
        sticky::delete(&db, "t", false).expect("删 t");
        assert_eq!(prune_empty(&db).expect("清"), 1, "两张都没了，组跟着走");
    }
}
