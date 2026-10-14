// 设置窗：外观 / 行为 / 数据 / 组合 / 长按右键 / 快捷键各一节。
// 设置项即时落库并广播；写失败一律回退到实际生效值，不留假勾假选中。

import { useCallback, useEffect, useRef, useState } from "react";
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
import { setLockAfterMark, useLockAfterMark } from "@/data/lock-after-mark";
import type { LockAfterMark } from "@/data/lock-after-mark";
import {
  AUTO_LOCK_DEFAULT_MIN,
  AUTO_LOCK_KEY,
  AUTO_LOCK_OPTIONS,
  autoLockMinutes,
} from "@/data/auto-lock";
import { listen } from "@/platform/bridge";
import {
  autostartGet,
  autostartSet,
  dataBackup,
  getSetting,
  openGuideWindow,
  settingsSet,
  snapshotList,
  snapshotRestore,
} from "@/platform/commands";
import type { Snapshot } from "@/platform/contracts";
import { AUTOSTART_CHANGED } from "@/platform/contracts";
import { logger } from "@/platform/logger";
import { HotkeySection } from "@/features/settings/hotkey-section";
import { HookSection } from "@/features/settings/hook-section";

const PANEL_BG = "var(--panel-bg)";
const PANEL_ACCENT = "var(--panel-ink)";

const SCHEME_OPTIONS: ReadonlyArray<{ value: SchemeSetting; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/** 叠窗呈现三档（默认分页） */
const GROUP_VIEW_OPTIONS: ReadonlyArray<{
  value: GroupPresentation;
  label: string;
  hint: string;
}> = [
  { value: "pages", label: "分页翻", hint: "一次一张，箭头与标题条上的小条切换" },
  { value: "tabs", label: "侧边色块签", hint: "正文占整宽，右缘一列方色签，悬停出名字" },
  { value: "accordion", label: "手风琴", hint: "一列到底，点标题行就地展开" },
];

/** 标记私密后的锁回档位 */
const LOCK_AFTER_OPTIONS: ReadonlyArray<{ value: LockAfterMark; label: string }> = [
  { value: "never", label: "不锁" },
  { value: "ask", label: "每次问我" },
  { value: "now", label: "立即锁" },
];

/** 恢复两段确认：第一击变确认键，3 秒不点退回 */
const RESTORE_RESET_MS = 3000;

/** `20261012-094703[-2]` → `2026-10-12 09:47:03` */
function formatSnapshotLabel(label: string): string {
  const stamp = label.slice(0, 15);
  if (!/^\d{8}-\d{6}$/.test(stamp)) return label;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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
  const [autostartOn, setAutostartOn] = useState<boolean | null>(null);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  /** null = 还没读到，暂不画选中 */
  const [autoLockMin, setAutoLockMin] = useState<number | null>(null);
  /** 模块级状态已在 boot 读过库，这里订阅着画 */
  const lockAfter = useLockAfterMark();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  /** 恢复成功后靠它重读库内档位（本窗关闭只是隐藏） */
  const [reloadSeq, setReloadSeq] = useState(0);
  const [armedRestore, setArmedRestore] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void getSetting(AUTO_LOCK_KEY)
      .then((value) => setAutoLockMin(autoLockMinutes(value)))
      .catch(() => setAutoLockMin(AUTO_LOCK_DEFAULT_MIN));
  }, [reloadSeq]);

  useEffect(() => {
    void getSetting("restore_on_boot")
      .then((value) => setRestoreOnBoot(value !== "0")) // 默认开，显式 "0" 才算关
      .catch(() => setRestoreOnBoot(true));
  }, [reloadSeq]);

  useEffect(() => {
    let cancelled = false;
    void snapshotList()
      .then((rows) => {
        if (cancelled) return;
        setSnapshots(rows);
        setSnapshotError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSnapshots([]);
        setSnapshotError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadSeq]);

  useEffect(() => {
    // 开机启动的事实来源是注册表：开窗读一次，托盘改动靠广播同步；读失败按未开启显示
    let off: (() => void) | null = null;
    let cancelled = false;
    void autostartGet()
      .then((enabled) => {
        if (!cancelled) setAutostartOn(enabled);
      })
      .catch((error: unknown) => {
        if (!cancelled) setAutostartOn(false);
        logger.caught("settings", "读开机启动状态失败，按没开显示", error);
      });
    void listen<boolean>(AUTOSTART_CHANGED, (enabled) => {
      setAutostartOn(enabled);
      setAutostartError(null);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const handleScheme = useCallback((next: SchemeSetting) => {
    changeScheme(next);
  }, []);

  const handleAutostartToggle = useCallback((checked: boolean) => {
    setAutostartOn(checked);
    setAutostartError(null);
    // 回显实际生效值：写失败退回并报错，不留假勾
    void autostartSet(checked)
      .then((actual) => setAutostartOn(actual))
      .catch((error: unknown) => {
        setAutostartOn(!checked);
        setAutostartError(String(error));
      });
  }, []);

  const handleRestoreToggle = useCallback((checked: boolean) => {
    setRestoreOnBoot(checked);
    void settingsSet("restore_on_boot", checked ? "1" : "0").catch(() => {
      setRestoreOnBoot(!checked); // 写失败退回界面
    });
  }, []);

  const handleAutoLock = useCallback(
    (minutes: number) => {
      const prev = autoLockMin;
      setAutoLockMin(minutes);
      // 落库失败退回原档（真相在库里，不留假选中）
      void settingsSet(AUTO_LOCK_KEY, String(minutes)).catch((error: unknown) => {
        logger.caught("settings", "自动上锁档位落库失败，退回原档", error);
        setAutoLockMin(prev ?? AUTO_LOCK_DEFAULT_MIN);
      });
    },
    [autoLockMin],
  );

  const handleBackup = useCallback(() => {
    if (backingUp) return;
    setBackingUp(true);
    void dataBackup()
      .then((path) => {
        setBackupMessage(`已备份到 ${path}`);
        setReloadSeq((seq) => seq + 1); // 新备份立刻进清单
      })
      .catch((error: unknown) => setBackupMessage(`备份失败：${String(error)}`))
      .finally(() => setBackingUp(false));
  }, [backingUp]);

  /** 两段确认：第一击变确认键，3 秒不点退回 */
  const handleSnapshotRestore = useCallback(
    (label: string) => {
      if (armedRestore !== label) {
        setArmedRestore(label);
        if (restoreTimer.current !== null) clearTimeout(restoreTimer.current);
        restoreTimer.current = setTimeout(() => setArmedRestore(null), RESTORE_RESET_MS);
        return;
      }
      if (restoreTimer.current !== null) clearTimeout(restoreTimer.current);
      setArmedRestore(null);
      setRestoring(true);
      void snapshotRestore(label)
        .then((report) => {
          setRestoreMessage(
            [
              `已恢复到 ${formatSnapshotLabel(report.restored)}。恢复前的状态存为 ${formatSnapshotLabel(report.safetyLabel)}。`,
              report.envelopeRestored
                ? "私密封套一起换回了，私密便签要重输一次口令。"
                : "这份快照没有配套的私密封套，私密真身仍是恢复前那份。",
              report.warning ?? "",
            ].join(" "),
          );
          // 整库已换：重读本窗从库里读的档位
          setReloadSeq((seq) => seq + 1);
        })
        .catch((error: unknown) => setRestoreMessage(`恢复失败：${String(error)}`))
        .finally(() => setRestoring(false));
    },
    [armedRestore],
  );

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
            深色对便签纸面与面板都生效；「跟随系统」随 Windows 即时切换。
          </p>
        </Section>

        <Section icon={<Power size={14} aria-hidden />} title="行为">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--panel-ink)]">
            <input
              type="checkbox"
              checked={autostartOn ?? false}
              onChange={(event) => handleAutostartToggle(event.target.checked)}
              disabled={autostartOn === null}
            />
            开机启动（登录后自动运行本应用）
          </label>
          <p className="mt-1.5 text-[11px] text-[var(--panel-muted)]">
            默认不开。登记的是当前 exe
            的完整路径，程序挪位置后要重新勾一次；与托盘里的开关同步。
          </p>
          {autostartError !== null && (
            <p role="alert" className="mt-1 break-all text-[11px] text-red-700">
              {autostartError}
            </p>
          )}
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-[var(--panel-ink)]">
            <input
              type="checkbox"
              checked={restoreOnBoot ?? true}
              onChange={(event) => handleRestoreToggle(event.target.checked)}
              disabled={restoreOnBoot === null}
            />
            开机自动恢复桌面上的便签
          </label>
          <p className="mt-1.5 text-[11px] text-[var(--panel-muted)]">
            关闭后，下次启动只显示托盘。
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
            写字顶高窗、删字缩回来，上限 900 像素。这是全局默认值；
            手动拉过边的那张退回固定尺寸，页脚按钮可按张单独翻。
          </p>
          <p className="mt-2 text-xs text-[var(--panel-ink)]">
            私密便签：揭开的那几张，便签窗内多久没操作就蒙回
          </p>
          <div
            role="radiogroup"
            aria-label="私密层自动上锁等待时长"
            className="mt-1.5 flex flex-wrap gap-1.5"
          >
            {AUTO_LOCK_OPTIONS.map((option) => {
              const active = autoLockMin === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={autoLockMin === null}
                  onClick={() => handleAutoLock(option.value)}
                  className="rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
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
            只认便签窗内的操作续期；到点把揭开的那几张一起蒙回，重输口令即回。改档即时生效。
          </p>
          <p className="mt-2 text-xs text-[var(--panel-ink)]">
            输完口令把一张便签标记成私密之后
          </p>
          <div
            role="radiogroup"
            aria-label="标记私密后是否立即锁回私密层"
            className="mt-1.5 flex flex-wrap gap-1.5"
          >
            {LOCK_AFTER_OPTIONS.map((option) => {
              const active = lockAfter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setLockAfterMark(option.value)}
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
            只对"输完口令自动补上标记"那一条路生效；这张已揭开时点标记不会再问。
          </p>
          <button
            type="button"
            onClick={() => {
              // 失败只记日志：这颗钮"没反应"比弹错更糟，现场要留得住
              void openGuideWindow().catch((error: unknown) =>
                logger.caught("settings", "打开引导教程失败", error),
              );
            }}
            className="mt-2.5 self-start rounded-md border border-[var(--panel-border)] px-3 py-1.5 text-xs transition-colors hover:bg-[var(--panel-hover)]"
            style={{ color: "var(--panel-ink)" }}
          >
            重看引导教程
          </button>
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
            一份快照 = 整库副本 + 私密封套副本，存在数据目录的 backups\ 下，只留最新 10
            份。
          </p>
          {snapshotError !== null && (
            <p role="alert" className="mt-1.5 break-all text-[11px] text-red-700">
              快照清单读不出来：{snapshotError}
            </p>
          )}
          {snapshots.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {snapshots.map((snap) => {
                const armed = armedRestore === snap.label;
                return (
                  <li
                    key={snap.label}
                    className="flex items-center gap-2 rounded-md border border-[var(--panel-border)] px-2 py-1"
                  >
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--panel-ink)]">
                      {formatSnapshotLabel(snap.label)}
                      <span className="ml-1.5 text-[var(--panel-muted)]">
                        {formatBytes(snap.bytes)}
                        {!snap.hasEnvelope && " · 无封套副本"}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={
                        armed
                          ? `确认恢复到 ${snap.label}（当前数据先自动存一份）`
                          : `恢复到 ${snap.label}`
                      }
                      onClick={() => handleSnapshotRestore(snap.label)}
                      disabled={restoring}
                      className="shrink-0 rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
                      style={{ color: armed ? "#B91C1C" : "var(--panel-muted)" }}
                    >
                      {armed ? "确认恢复" : "恢复"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {snapshots.length === 0 && snapshotError === null && (
            <p className="mt-2 text-[11px] text-[var(--panel-muted)]">还没有快照。</p>
          )}
          {restoreMessage !== null && (
            <p role="status" className="mt-1.5 text-[11px] text-[var(--panel-ink)]">
              {restoreMessage}
            </p>
          )}
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
          {/* 说明与档位同一张选项表，加档不会漏 */}
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
            切档不动任何数据，已开的叠窗立刻跟随。
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
