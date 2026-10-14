// 设置窗 — 外观（三档主题）/ 行为（开机启动、开机恢复、自动长高）/ 数据（立即备份）三节。
// 改主题走 changeScheme（落库 + 广播，其它窗即时跟随）；
// 开机启动读写注册表（autostart_*），开机恢复与备份直接读写 settings / data_backup 命令。

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

/** 输完口令把这张标记成私密之后怎么办。三档，控件与上面那组一样 */
const LOCK_AFTER_OPTIONS: ReadonlyArray<{ value: LockAfterMark; label: string }> = [
  { value: "never", label: "不锁" },
  { value: "ask", label: "每次问我" },
  { value: "now", label: "立即锁" },
];

/** 「恢复」的两段确认与回收站那两条同一个节奏：第一击变确认键，3 秒不点自动退回 */
const RESTORE_RESET_MS = 3000;

/** `20261012-094703[-2]` → `2026-10-12 09:47:03`（同秒避让的尾巴不显示，那是文件名的事） */
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
  /** null = 还没读到（那一瞬所有档都不画选中，不猜一个给人看） */
  const [autoLockMin, setAutoLockMin] = useState<number | null>(null);
  /** 标记私密后的锁档：模块级状态已在 boot 读过库，这里只是订阅着画 */
  const lockAfter = useLockAfterMark();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  /** 恢复成功要重读的那一批：这一窗是"关=藏起来"的，不重载就停在恢复前的读数上 */
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
    // 开机启动的事实来源是注册表，不是库：开窗读一次，托盘那边改了会广播，这里跟着重读。
    // 读失败按"没开"显示——这条默认就是关的，一次读失败不许把勾画到"开着"那一边。
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
    // 回显的是**实际生效值**：写不进去（注册表被安全软件拦）就退回原样并把原因说出来，
    // 不能留一个"看着勾上了、下次开机却没启动"的假勾
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
      // 落库失败就退回原档：这一档的真相在库里（Rust 那条循环直接读它），
      // 界面上留一个"看着改了、其实没改"的假选中比退回原样更糟
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
        setReloadSeq((seq) => seq + 1); // 刚打的那一份要立刻出现在下面那份清单里
      })
      .catch((error: unknown) => setBackupMessage(`备份失败：${String(error)}`))
      .finally(() => setBackingUp(false));
  }, [backingUp]);

  /** 两段确认：第一击只把这一行变成"确认恢复"，3 秒不点自动退回（与回收站同一条节奏） */
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
          // 整库都换了：这一窗自己那些从库里读的档位必须重读，不然显示的是上一个库的
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
            深色档对便签纸面与全部面板生效；「跟随系统」随 Windows 的深浅色即时切换。
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
            默认不开。勾上登记的是**当前这个 exe
            的完整路径**——程序挪过位置就要取消再重新勾一次；
            托盘菜单里那一条勾与这里是同一个状态，两边改哪边都同步。
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
            只认便签窗里的点击、按键与滚轮——在设置窗或搜索窗里打字不算续期。到点那一发
            与托盘那条「立即锁定私密便签」是同一条路：**把揭开的那几张一起蒙回**，每张的钥匙
            只从内存清掉，盘上的封套与密文原样，回到那张便签上重输口令就回来。
            逐张模型里没有"只蒙回其中几张"这种半动作。改档即时生效，不用重启。
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
            只管"这张还没揭开、点标记私密于是弹口令窗"那一条路：输完口令这张自动补上标记，
            然后按这里的选择蒙回去、不蒙、还是当场问一句（问的话是页脚那颗锁钮变 5
            秒的确认态， 点它才锁）。这一张已经开着时点标记不会问——那一下你没输过密码。
            删私密便签那道口令门补完之后也不问，蒙回去只会挡住你确认刚删了什么。
          </p>
          <button
            type="button"
            onClick={() => {
              // 失败只记一行：这一窗里点这颗钮没反应，比弹个错更容易被当成"没做出来"，
              // 所以现场要留得下来
              void openGuideWindow().catch((error: unknown) =>
                logger.caught("settings", "打开引导教程失败", error),
              );
            }}
            className="mt-2.5 self-start rounded-md border border-[var(--panel-border)] px-3 py-1.5 text-xs transition-colors hover:bg-[var(--panel-hover)]"
            style={{ color: "var(--panel-ink)" }}
          >
            重看引导教程
          </button>
          <p className="mt-1.5 text-[11px] text-[var(--panel-muted)]">
            十二步，一步一停，从长按右键到私密层与备份。首次启动会自动演一次，看过之后只剩这颗钮。
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
            一份快照 = 整个库（<code>VACUUM INTO</code> 的干净副本，含 WAL）+
            同名的私密封套 副本，存放在数据目录的 backups\ 下，可用任意 SQLite
            工具打开。只留最新 10 份。
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
            <p className="mt-2 text-[11px] text-[var(--panel-muted)]">
              还没有快照。点上面那颗钮就有了。
            </p>
          )}
          {restoreMessage !== null && (
            <p role="status" className="mt-1.5 text-[11px] text-[var(--panel-ink)]">
              {restoreMessage}
            </p>
          )}
          <p className="mt-1.5 text-[11px] text-[var(--panel-muted)]">
            恢复是整库换回那一刻：现在的数据不会丢，它会先被自动存成一份新快照。
            换完揭开的那几张会**当场蒙回**（内存里那些钥匙对应的是换掉之前的封套），
            回到那张便签上重输口令即可。所有开着的便签窗会自己重读。
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
