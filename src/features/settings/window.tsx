// 设置窗 — 外观（三档主题）/ 行为（开机恢复）/ 数据（立即备份）三节。
// 改主题走 changeScheme（落库 + 广播，其它窗即时跟随）；
// 开机恢复与备份直接读写 settings / data_backup 命令。

import { useCallback, useEffect, useState } from "react";
import { Database, MousePointerClick, Power, SunMoon, Keyboard } from "lucide-react";
import { WindowChrome } from "@/ui/window-chrome";
import { changeScheme, useScheme } from "@/data/scheme";
import type { SchemeSetting } from "@/data/scheme";
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
