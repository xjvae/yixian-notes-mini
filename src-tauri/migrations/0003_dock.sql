-- v3：贴边吸附状态。docked=1 时窗体以 20px 细丝贴在 dock_edge 一侧；
-- 拖离边缘即解除（前端负责判定与动画），这里只是状态的持久化归宿。
ALTER TABLE stickies ADD COLUMN docked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stickies ADD COLUMN dock_edge TEXT;
