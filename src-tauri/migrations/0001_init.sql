-- 一闲笔记 mini · schema v1（全新起点，2026-09-30）
-- 设计口径：布尔一律 INTEGER 0/1；时间戳 epoch ms 由 Rust 写入侧权威生成；
-- items/tags 以 JSON 列存储（行内小结构，不值得为此开表）。

CREATE TABLE stickies (
    id           TEXT PRIMARY KEY,
    title        TEXT    NOT NULL DEFAULT '',
    body         TEXT    NOT NULL DEFAULT '',
    content_type TEXT    NOT NULL DEFAULT 'text',
    items_json   TEXT    NOT NULL DEFAULT '[]',
    tags_json    TEXT    NOT NULL DEFAULT '[]',
    theme        TEXT    NOT NULL DEFAULT 'yellow',
    pinned       INTEGER NOT NULL DEFAULT 1,
    floating     INTEGER NOT NULL DEFAULT 1,
    collapsed    INTEGER NOT NULL DEFAULT 0,
    private      INTEGER NOT NULL DEFAULT 0,
    group_id     TEXT,
    x            INTEGER,
    y            INTEGER,
    width        INTEGER,
    height       INTEGER,
    due_at       INTEGER,
    done_at      INTEGER,
    repeat       TEXT    NOT NULL DEFAULT 'none',
    deleted      INTEGER NOT NULL DEFAULT 0,
    deleted_at   INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_stickies_deleted ON stickies (deleted);
CREATE INDEX idx_stickies_group   ON stickies (group_id);

CREATE TABLE groups (
    id         TEXT PRIMARY KEY,
    name       TEXT    NOT NULL,
    color      TEXT,
    collapsed  INTEGER NOT NULL DEFAULT 0,
    x          INTEGER,
    y          INTEGER,
    width      INTEGER,
    height     INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE window_state (
    label  TEXT PRIMARY KEY,
    x      INTEGER NOT NULL,
    y      INTEGER NOT NULL,
    width  INTEGER NOT NULL,
    height INTEGER NOT NULL
);
