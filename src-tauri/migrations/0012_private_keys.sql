-- 0012 — 一张一把钥匙：一次口令只开一张，不是开整层
--   一行 = 一张便签自己的随机密钥（32 字节），被口令派生的 master 包着
--   （`crypto::seal_blob`，AAD = `yixian-private-v1:note-key:<noteId>`，绑在自己那张上）。
-- master **不常驻内存**：只在"揭开那一张"这一步里存在，完事就丢——别的张没口令就解不开。
-- 判据用"这张有没有键行"：有 → 正文/历史/图都在这把钥匙下；没有 → 等这张**第一次被揭开**时
--   当场搬进来（一个事务：建键行 + 重写正文与历史 + 重裹名下图）。不全搬是因为全搬要握着
--   一把能开整层的钥匙，正是这一版要拆掉的东西。
-- 不用外键（全库没有 FOREIGN KEY，同 0005_media.sql）：硬删一张要显式带走键行，见 `sticky::delete` 与 `trash::clear/purge_expired`。
CREATE TABLE private_keys (
    note_id    TEXT PRIMARY KEY,
    key        BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
