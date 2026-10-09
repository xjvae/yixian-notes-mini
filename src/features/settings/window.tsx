// 设置窗 — 外观（三档主题）/ 行为（开机恢复）/ 数据（立即备份）三节。
// 改主题走 changeScheme（落库 + 广播，其它窗即时跟随）；
// 开机恢复与备份直接读写 settings / data_backup 命令。

import { useCallback, useEffect, useState } from "react";
import {
  Database,
  Layers,
  MousePointerClick,
  Power,
  SunMoon,
  Keyboard,
} from "lucide-react";
import { WindowChrome } from "@/ui/window-chrome";
import { changeScheme, useScheme } from "@/data/scheme";
import type { SchemeSetting } from "@/data/scheme";
import { changeGroupPresentation, useGroupPresentation } from "@/data/group-presentation";
import type { GroupPresentation } from "@/data/group-presentation";
import { setAutoSizeDefault, useAutoSizeDefault } from "@/data/auto-size-default";
import { dataBackup, getSetting, settingsSet } from "@/platform/commands";
import { HotkeySection } from "@/features/settings/hotkey-section";
import { HookSection } from "@/features/settings/hook-section";

const PANEL_BG = "var(--panel-bg)";
const PANEL_ACCENT = "var(--panel-ink)";

const SCHEME_OPTIONS: ReadonlyArray<{ value: SchemeSetting; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/** 默认分页：层叠卡片是新加的那一版，得留一条一眼退回原样子的路 */
const GROUP_VIEW_OPTIONS: ReadonlyArray<{
  value: GroupPresentation;
  label: string;
  hint: string;
}> = [
  { value: "pages", label: "分页翻", hint: "一次一张，箭头与标题条上的小条切换" },
  { value: "tabs", label: "侧边色块签", hint: "正文占整宽，右缘一列方色签，悬停出名字" },
  { value: "accordion", label: "手风琴", hint: "一列到底，点标题行就地展开" },
];

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-card)] p-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--panel-ink)]">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SettingsWindow() {
  const { setting } = useScheme();
  const groupView = useGroupPresentation();
  const autoSizeOn = useAutoSizeDefault();
  const [restoreOnBoot, setRestoreOnBoot] = useState<boolean | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);

  useEffect(() => {
    void getSetting("restore_on_boot")
      .then((value) => setRestoreOnBoot(value !== "0")) // 默认开，显式 "0" 才算关
      .catch(() => setRestoreOnBoot(true));
  }, []);

  const handleScheme = useCallback((next: SchemeSetting) => {
    changeScheme(next);
  }, []);

  const handleRestoreToggle = useCallback((checked: boolean) => {
    setRestoreOnBoot(checked);
    void settingsSet("restore_on_boot", checked ? "1" : "0").catch(() => {
      setRestoreOnBoot(!checked); // 写失败退回界面
    });
  }, []);

  const handleBackup = useCallback(() => {
    if (backingUp) return;
    setBackingUp(true);
    void dataBackup()
      .then((path) => setBackupMessage(`已备份到 ${path}`))
      .catch((error: unknown) => setBackupMessage(`备份失败：${String(error)}`))
      .finally(() => setBackingUp(false));
  }, [backingUp]);

  return (
    <WindowChrome
      background={PANEL_BG}
      accent={PANEL_ACCENT}
      pinned={false}
      onTogglePin={() => {}}
      onClose={() => {
        void closeWindow();
      }}
    >
      <div className="flex h-full flex-col gap-2.5 overflow-y-auto p-4">
        <h1 className="text-sm font-semibold text-[var(--panel-ink)]">设置</h1>

        <Section icon={<SunMoon size={14} aria-hidden />} title="外观">
          <div role="radiogroup" aria-label="主题" className="flex gap-1.5">
            {SCHEME_OPTIONS.map((option) => {
              const active = setting === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => handleScheme(option.value)}
                  className="rounded-md border px-3 py-1.5 text-xs transition-colors"
                  style={{
                    borderColor: active ? "var(--panel-ink)" : "var(--panel-border)",
                    backgroundColor: active ? "var(--panel-hover)" : "transparent",
                    color: "var(--panel-ink)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--panel-muted)]">
            深色档对便签纸面与全部面板生效；「跟随系统」随 Windows 的深浅色即时切换。
          </p>
        </Section>

        <Section icon={<Power size={14} aria-hidden />} title="行为">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--panel-ink)]">
            <input
              type="checkbox"
              checked={restoreOnBoot ?? true}
              onChange={(event) => handleRestoreToggle(event.target.checked)}
              disabled={restoreOnBoot === null}
            />
            开机自动恢复桌面上的便签
          </label>
          <p className="mt-1.5 text-[11px] text-[var(--panel-muted)]">
            关闭后，下次启动只显示托盘，便签要在托盘里手动唤起（星环落地后）。
          </p>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-[var(--panel-ink)]">
            <input
              type="checkbox"
              checked={autoSizeOn}
              onChange={(event) => setAutoSizeDefault(event.target.checked)}
            />
            便签随内容自动长高（有图时宽按图对齐）
          </label>
          <p className="mt-1.5 text-[11px] text-[var(--panel-muted)]">
            开着时写的字把窗顶高、删了缩回来，上限 900 像素，多出来的正文自己滚。
            这是**默认值**：手拉某一扇窗的边就把那一张退回固定尺寸，
            每张便签页脚那个按钮还能单独翻（跟随全局 / 强制自动 / 强制固定三档）。
          </p>
        </Section>

        <Section icon={<Database size={14} aria-hidden />} title="数据">
          <button
            type="button"
            onClick={handleBackup}
            disabled={backingUp}
            className="rounded-md border border-[var(--panel-border)] px-3 py-1.5 text-xs transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
            style={{ color: "var(--panel-ink)" }}
          >
            {backingUp ? "正在备份…" : "立即备份"}
          </button>
          {backupMessage !== null && (
            <p
              role="status"
              className="mt-1.5 break-all text-[11px] text-[var(--panel-muted)]"
            >
              {backupMessage}
            </p>
          )}
          <p className="mt-1.5 text-[11px] text-[var(--panel-muted)]">
            备份是完整快照，存放在数据目录的 backups\ 下，可用任意 SQLite 工具打开。
          </p>
        </Section>

        <Section icon={<Layers size={14} aria-hidden />} title="组合（叠窗）">
          <div
            role="radiogroup"
            aria-label="叠窗呈现方式"
            className="flex flex-wrap gap-1.5"
          >
            {GROUP_VIEW_OPTIONS.map((option) => {
              const active = groupView === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => changeGroupPresentation(option.value)}
                  className="rounded-md border px-3 py-1.5 text-xs transition-colors"
                  style={{
                    borderColor: active ? "var(--panel-ink)" : "var(--panel-border)",
                    backgroundColor: active ? "var(--panel-hover)" : "transparent",
                    color: "var(--panel-ink)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {/* 说明按档位列出来自同一张选项表：加了档忘了写说明，这里就会少一条 */}
          <ul className="mt-2 space-y-0.5">
            {GROUP_VIEW_OPTIONS.map((option) => (
              <li
                key={option.value}
                className="text-[11px]"
                style={{
                  color:
                    groupView === option.value
                      ? "var(--panel-ink)"
                      : "var(--panel-muted)",
                  fontWeight: groupView === option.value ? 600 : 400,
                }}
              >
                {option.label}：{option.hint}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-[var(--panel-muted)]">
            三档共用同一份成员序与同一张"当前在看哪一张"，切档不动任何数据；
            已开的叠窗立刻跟着换，不用重开。
          </p>
        </Section>

        <Section icon={<MousePointerClick size={14} aria-hidden />} title="长按右键">
          <HookSection />
        </Section>

        <Section icon={<Keyboard size={14} aria-hidden />} title="全局快捷键">
          <HotkeySection />
        </Section>
      </div>
    </WindowChrome>
  );
}

async function closeWindow(): Promise<void> {
  const { closeSettingsWindow } = await import("@/platform/commands");
  await closeSettingsWindow().catch(() => {});
}
