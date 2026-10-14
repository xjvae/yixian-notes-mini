// 手风琴视图 — 一列到底：收起的每张一条标题行，展开那张吃掉剩余高度就地编辑。
//
// 与"两张并排"那版比过：并排会把每列压到 160px 宽以内，正文和待办框都挤。上下这版
// 正文永远占整宽，收起行只花 24px。高度分配（含"十几张时展开那张守住 120px 下限、
// 整列改滚"）在 `stack-model` 的 `accordionRows` 里，这里只按算出来的高度摆。

import { memo, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { NoteContent } from "@/features/sticky/note-content";
import { GroupMenu } from "@/features/sticky/group-menu";
import { displayName, todoChip, type StackViewProps } from "@/features/sticky/stack-view";
import { useContentBox } from "@/features/sticky/use-content-box";
import { themeColors } from "@/data/theme";
import { useScheme, type ResolvedScheme } from "@/data/scheme";
import { positionOf, accordionRows } from "@/window/stack-model";
import type { StickyNote } from "@/platform/contracts";

/**
 * 收起的标题行 memo 化：本叠里正在编辑的那张每敲一个字都会换 members 数组引用，
 * 但收起行的 member 对象引用不动——memo 把它们的重渲整段跳过（这正是叠窗打字
 * 放大重渲的另一半：只砍掉订阅面不够，行还得各自挡住）。
 */
const AccordionRowButton = memo(function AccordionRowButton({
  member,
  resolved,
  height,
  onPick,
}: {
  member: StickyNote;
  resolved: ResolvedScheme;
  height: number;
  onPick: (id: string) => void;
}) {
  const theme = themeColors(member.theme, resolved);
  const name = displayName(member);
  const chip = todoChip(member);
  return (
    <button
      type="button"
      aria-label={`展开「${name}」`}
      title={`${name}（点一下展开）`}
      onClick={() => onPick(member.id)}
      className="flex w-full shrink-0 items-center gap-1.5 border-b border-black/5 px-2 text-left transition-colors hover:bg-black/5"
      style={{ height }}
    >
      <ChevronRight
        size={11}
        aria-hidden
        style={{ color: theme.accent, opacity: 0.55 }}
      />
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: theme.accent }}
      />
      <span
        className="min-w-0 flex-1 truncate text-[11px] font-semibold"
        style={{ color: theme.accent }}
      >
        {name}
      </span>
      {chip !== null && (
        <span className="shrink-0 text-[10px]" style={{ color: theme.ink, opacity: 0.6 }}>
          {chip}
        </span>
      )}
    </button>
  );
});

export function GroupAccordion({ members, currentId, onPick, onDelete }: StackViewProps) {
  const { resolved } = useScheme();
  const [boxRef, box] = useContentBox();
  const openAt = positionOf(members, currentId) ?? 0;
  const { rows, scroll } = useMemo(
    () => accordionRows(members.length, openAt, box),
    [members.length, openAt, box],
  );

  return (
    <div
      ref={boxRef}
      className="flex h-full w-full flex-col overflow-x-hidden"
      style={{ overflowY: scroll ? "auto" : "hidden" }}
    >
      {rows.map((row) => {
        const member = members[row.index];
        if (member === undefined) return null;
        if (row.open) {
          return (
            <div
              key={member.id}
              className="min-h-0 shrink-0 overflow-hidden"
              style={{ height: row.height }}
            >
              <NoteContent
                id={member.id}
                note={member}
                leadingActions={<GroupMenu id={member.id} groupId={member.groupId} />}
                onDelete={onDelete}
              />
            </div>
          );
        }
        return (
          <AccordionRowButton
            key={member.id}
            member={member}
            resolved={resolved}
            height={row.height}
            onPick={onPick}
          />
        );
      })}
    </div>
  );
}
