-- v8：叠窗（组合）也能贴边。与 v3 给单窗的那两列同形状同意义（docked=1 时那一叠以 20px
-- 细丝贴在 dock_edge 一侧，判定与动画在前端 `use-dock-snap`）。
-- 为什么不借窗自身的记忆（`window_state`）：细丝那 20×20 也是几何，记进去就分不出
-- "贴着"与"被摆成一小块"——状态与几何必须分开住。
ALTER TABLE groups ADD COLUMN docked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN dock_edge TEXT;
