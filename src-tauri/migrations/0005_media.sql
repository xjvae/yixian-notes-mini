-- v5：便签正文里的图片，字节住库不落文件系统。
-- 为什么不是目录：这个应用"数据"只有一个去处——备份是 `VACUUM INTO` 出一份库文件、
-- 旧库导入只读一个 mini.db；图放进目录就凭空多出第二类数据，备份会漏、清算会留孤儿文件。
-- enc=1：bytes 是密文，用**那张便签自己的钥匙**加的（见 0012），那张没揭开就读不出来。
-- 不用外键（全库都没有）：新建那张的行可能还没落库（store 250ms 才 flush），加了外键就是
-- "刚粘的图存不进去"。删便签时按 note_id 显式带走，见 `sticky::delete` 的硬删分支。
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
