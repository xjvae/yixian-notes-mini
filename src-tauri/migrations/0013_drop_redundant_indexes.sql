-- 0013 — 删掉两条与主键重复的索引
--
-- 两条都是 `(note_id, seq [DESC])`，而对应表的主键已经是 `(note_id, seq)`：SQLite 能反向扫
-- 升序索引，`WHERE note_id = ? ORDER BY seq DESC` 用的就是主键那一棵。多出来这一棵不改变
-- 任何查询计划，只让**每次记版多写一个 B 树**（每张 50 版 × 500 张那种量级时白躺 1.5–2 MB）。
-- 用 EXPLAIN QUERY PLAN 验过删完仍走主键，见 `db/migrate.rs` 的那条用例。
DROP INDEX IF EXISTS idx_revisions_note;
DROP INDEX IF EXISTS idx_private_revision_note;
