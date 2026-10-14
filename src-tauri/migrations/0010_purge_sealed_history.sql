-- 0010 — 清掉"标记成私密之前"留在明文历史表里的版本（历史遗留；防漏的判据已经补在
-- `revision::record` 的 going_private，那一次写会先跳过记版）。
-- 漏判的是这一刻：把一张**非私密**便签改成私密的那次写，先把它"上一版"（那时还是明文）
-- 记进了谁都能读的 sticky_revisions，于是刚被保护起来的真身永久留在一份没加密的历史里。
-- 判据用行上的 private 标记，不用封套：封套对 Rust 是 opaque 的。
DELETE FROM sticky_revisions
WHERE note_id IN (SELECT id FROM stickies WHERE private = 1);
