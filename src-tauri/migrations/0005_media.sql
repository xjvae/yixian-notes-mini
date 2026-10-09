-- v5：便签正文里的图片。字节直接住库，不落文件系统。
--
-- 为什么是库不是目录：这个应用里"数据"只有一个去处——备份是 `VACUUM INTO` 出一份
-- 库文件（commands/db.rs:57），旧库导入只读一个 mini.db（import.rs）。图放进目录
-- 就等于凭空多出第二类数据，备份会漏、回收站清算会留孤儿文件、迁移要搬两处。
-- 按本机实测一张截图 50 KB 量级，100 张 ≈ 5 MB 库，SQLite 完全不当回事。
--
-- enc=1：bytes 是密文（私密封套里的媒体密钥加过，见 data/private.rs::media_key）。
-- 没解锁就读不出来——私密便签的图与正文是同一条边界，一张图比一行字更说得清
-- 那张在记什么。
--
-- 不用外键：全库没有一处 FOREIGN KEY（stickies 与 groups 也是显式清理，见
-- group::prune_empty），而且新建那张便签的行可能还没落库（store 250ms 才 flush），
-- 加了外键就是"刚粘的图存不进去"。删便签时按 note_id 显式带走，见 media::delete_for_note。
CREATE TABLE media (
    id         TEXT PRIMARY KEY,
    note_id    TEXT NOT NULL,
    mime       TEXT NOT NULL,
    bytes      BLOB NOT NULL,
    enc        INTEGER NOT NULL DEFAULT 0,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_media_note ON media (note_id);
