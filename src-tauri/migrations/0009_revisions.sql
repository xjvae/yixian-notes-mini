-- v9：单张便签的历史版本（整库快照之外的第二条恢复路）。
-- 一行 = 这张**被换掉之前**那个内容形状。写路径每 250ms flush 一次，存"换掉之后"会把
-- 同一句话拆成几十行；存"换掉之前"天然一行一档，而回滚要的正是"我改坏之前那一份"。
-- 只存内容字段：摆位、尺寸、置顶、贴边、收起、归组、自动长高不进版本——那是"这扇窗怎么摆"，
-- 不是"这张纸写了什么"。三份 `*_json` 存列里那份**原样字符串**、不重新序列化：回滚写回同一串，
-- 键序与空格都不漂，比"有没有变过"也就是比字符串。
-- 私密便签不记（判据在 `query/revision.rs`）：这张表明文可读，把真身抄一份进来等于用一次
-- "存历史"把私密层拆掉。不用外键（全库都没有）：硬删时按 note_id 显式带走。
CREATE TABLE sticky_revisions (
    note_id       TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    content_json  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (note_id, seq)
);

CREATE INDEX idx_revisions_note ON sticky_revisions (note_id, seq DESC);
