-- v6：便签随内容自动长高。三态而不是布尔：NULL = 跟全局开关（`sticky.auto_size`）走，
-- 1 = 这张强制自动，0 = 这张强制固定。压成布尔就分不开"跟着全局"与"我就是要固定"，
-- 而后者正是这个模式要留的口子。
-- 自动模式**不往 width/height 写**：手拉出来的固定值必须原样躺在行里，关掉自动那一刻回得去。
ALTER TABLE stickies ADD COLUMN auto_size INTEGER;
