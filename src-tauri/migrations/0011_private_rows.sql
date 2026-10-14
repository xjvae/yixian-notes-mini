-- 0011 — 私密正文从「整份封套」改成「逐条密文」
--
-- 为什么换：v1 把所有私密便签（连每张最多 50 版历史）当成**一个** JSON map 整份加密，
-- 于是每 250ms 一次去抖落库都要整份重加密、整份重写（实测 10 张各满 50 版 = 文件 10 MB、
-- 单次写侧序列化+加密 41 ms，30 张 99 ms）。改成逐条后一次只封那一张（~50 KB、<2 ms）。
-- content 列 = `crypto::seal_blob` 的产物（nonce 前缀 + GCM 密文 + tag），AAD 把密文钉在
-- 自己那一行上（`content_aad` / `revision_aad`）。密钥那一层后来改成一张一把，见 0012。
-- seq 与 created_at 留明文：列表要按 seq 倒序、清理要按天夹，而这两个数单独拿出来不含正文。
CREATE TABLE private_content (
    note_id    TEXT PRIMARY KEY,
    content    BLOB NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE private_revision (
    note_id    TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    content    BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (note_id, seq)
);

CREATE INDEX idx_private_revision_note ON private_revision (note_id, seq DESC);
