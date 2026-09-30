// 提醒字段面板 — 到期时刻、重复档、完成勾选。
// 勾"完成"的语义按重复档分岔（due.ts 的口径）：有重复 = 推进到下一次（不算完成）；
// 无重复 = 盖 done_at（角标变「已完成」）。这条分岔就是"提醒到点真有反馈"的全部来源。

import type { ReminderRepeat } from "@/platform/contracts";
import { fromLocalInputValue, nextOccurrence, toLocalInputValue } from "@/data/due";

interface Props {
  dueAt: number | null;
  doneAt: number | null;
  repeat: ReminderRepeat;
  ink: string;
  accent: string;
  onChange: (patch: {
    dueAt?: number | null;
    doneAt?: number | null;
    repeat?: ReminderRepeat;
  }) => void;
}

const REPEAT_OPTIONS: ReadonlyArray<{ value: ReminderRepeat; label: string }> = [
  { value: "none", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
];

export function ReminderFields({ dueAt, doneAt, repeat, ink, accent, onChange }: Props) {
  const isDone = doneAt !== null;

  const toggleDone = (): void => {
    if (isDone) {
      onChange({ doneAt: null });
      return;
    }
    // 有重复且已设到期：推进下一次；否则本次完成
    if (repeat !== "none" && dueAt !== null) {
      const next = nextOccurrence(dueAt, repeat);
      if (next !== null) {
        onChange({ dueAt: next });
        return;
      }
    }
    onChange({ doneAt: Date.now() });
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px]">
      <label className="flex items-center gap-1" style={{ color: ink }}>
        到期
        <input
          type="datetime-local"
          value={dueAt === null ? "" : toLocalInputValue(dueAt)}
          aria-label="到期时间"
          onChange={(event) =>
            onChange({ dueAt: fromLocalInputValue(event.target.value) })
          }
          className="rounded border-0 bg-transparent px-1 py-0.5 text-[11px]"
          style={{ color: ink }}
        />
      </label>
      <label className="flex items-center gap-1" style={{ color: ink }}>
        重复
        <select
          value={repeat}
          aria-label="重复档"
          onChange={(event) => onChange({ repeat: event.target.value as ReminderRepeat })}
          className="rounded bg-transparent px-0.5 py-0.5"
          style={{ color: ink }}
        >
          {REPEAT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex cursor-pointer items-center gap-1" style={{ color: accent }}>
        <input
          type="checkbox"
          checked={isDone}
          onChange={toggleDone}
          aria-label={isDone ? "标记为未完成" : "标记为已完成"}
          className="accent-current"
        />
        {isDone ? "已完成" : "完成"}
      </label>
    </div>
  );
}
