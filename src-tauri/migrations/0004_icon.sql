-- v4：侧边色块签的自定义图标。icon 存的是前端注册表里的 key（如 "star"），
-- NULL = 没设过，签上回落到"由便签类型推出来"的那一个。
-- 只加一列、不建索引：它是给眼睛看的标记，不是查询条件。
ALTER TABLE stickies ADD COLUMN icon TEXT;
