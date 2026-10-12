-- v9：单张便签的历史版本（设置之外的第二条恢复路：整库快照见 commands/snapshot.rs）。
--
-- 一行 = 这张便签**被换掉之前**的那个内容形状。为什么存"换掉之前"而不是"换掉之后"：
-- 写路径每 250ms 就 flush 一次（store 的去抖），存"之后"等于把同一个句子拆成几十行；
-- 存"之前"天然一行一档——回滚要的正是"我改坏之前那一份"。
--
-- 只存内容字段（标题/正文/类型/清单/时间轴/标签/颜色/图标/到期/重复）。
-- 摆位、尺寸、置顶、贴边、收起、归组、自动长高**不进版本**：那些是"这扇窗怎么摆"，
-- 不是"这张纸写了什么"。回滚一次历史不该把便签从屏幕右下角搬走、或者悄悄取消置顶。
--
-- items_json / timeline_json / tags_json 存的是列里那份**原样字符串**，不重新序列化：
-- 回滚时直接写回同一串，键序与空格都不会漂，比较"有没有变过"也就是比字符串。
--
-- 私密便签不记（见 query/revision.rs 那句 private 判定）。这张表明文落盘，
-- 把封套里的真身抄一份进来等于用一次"存历史"把私密层拆掉。私密内容的历史只有一条：
-- 整库快照连着封套那一份。
--
-- 不用外键：全库没有一处 FOREIGN KEY（同 0005_media.sql 那段理由）。删便签时按
-- note_id 显式带走，见 sticky::delete 的硬删分支。
CREATE TABLE sticky_revisions (
    note_id       TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    content_json  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (note_id, seq)
);

CREATE INDEX idx_revisions_note ON sticky_revisions (note_id, seq DESC);
