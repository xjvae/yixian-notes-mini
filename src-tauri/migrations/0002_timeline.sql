-- v2：时间轴便签的条目列。timeline 是这一类便签的正文（带时刻的对象数组），
-- 与 items（清单）分列存储，互不混用。
ALTER TABLE stickies ADD COLUMN timeline_json TEXT NOT NULL DEFAULT '[]';
