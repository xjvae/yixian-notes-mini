// 便签右键菜单的判定 — "右键点在什么上"→"该给哪几项"。纯函数，不碰 DOM——为的是每条分支都能钉进用例，
// 而不是靠手点五种位置去回忆规则。
// 尾巴那几项是**同一串**（加图 / 复制正文 / 历史版本 / 私密 / 收起 / 删除）：通用项不随目标消失；
// 收起只在单窗有，由调用方传 `canCollapse`，这里不猜。历史版本不分私密——私密版本住封套里锁着读不到，入口照给。
// 危险项（删除便签、删掉这张图）一律排在各自那一段的最后，不让人闭着眼点到。

import type { RowRef } from "@/features/sticky/row-target";
// 动作契约住在 ui 层（ContextMenu 渲染它，这里只做"给哪几项"的判定）：
// import 供本文件判定用，re-export 保持 note-content 等调用点的原路径不变
import type { MenuAction } from "@/ui/menu-action";

export type { MenuAction, MenuActionId } from "@/ui/menu-action";

/** 右键落在什么上 */
export type MenuHit =
  /**
   * 选中了正文里的字（selected 非空才算，空选择按 note 处理）。
   * `range` = 这段选中在**正文**里的原文区间；对不上正文（选跨了链接/代码/图）就是
   * null —— 只给复制，不给"变成链接"。
   */
  | { kind: "text"; selected: string; range: { start: number; end: number } | null }
  /**
   * 选中了**某一条**里的字（清单条目、时间轴那条记录）。区间是那条自己的文本区间，写回也写进那条。
   */
  | { kind: "row"; row: RowRef; selected: string; range: { start: number; end: number } }
  /**
   * 编辑态那块 textarea 里选中了字（区间直接来自 `selectionStart/End`，天生精确）。
   * 只在**有选区**时才用这一档：空白处右键要留给系统菜单——粘贴/撤销/拼写在那儿，我们给不了那几样。
   */
  | { kind: "editor"; selected: string; range: { start: number; end: number } }
  | { kind: "link"; href: string }
  /**
   * 本机图库里的图（media:// 那句引用对应的字节）。`row` = 这张在清单/时间轴的某一条里
   * （null = 在正文里）——决定"删掉这张图"那句引用要从哪儿摘。
   */
  | { kind: "image"; mediaId: string; row: RowRef | null }
  /** 远程图芯片（不自动加载那一类，href 是 http/https） */
  | { kind: "remoteImage"; href: string }
  | { kind: "note" };

export interface NoteState {
  isPrivate: boolean;
  collapsed: boolean;
  /** 单窗才有"收起为标题栏"这一档；叠窗没有 */
  canCollapse: boolean;
  /** 手里这张图那句引用在不在（正文或那一条里），在才给"删掉这张图" */
  canDeleteImage: boolean;
  /**
   * "复制这一块文本"那一项叫什么。四类便签的正文不在同一个字段（文本/提醒是 `body`、清单是 `items[].text`、
   * 时间轴是 `timeline[].text`，见 `data/note-types.ts` 的 `plainBody`），文案得跟着类型走——不然清单上写"复制正文"、复制出来是空串。
   */
  bodyLabel: string;
}

/** 通用尾巴。顺序即菜单里的顺序，删除便签在最后 */
function commonTail(note: NoteState): MenuAction[] {
  const items: MenuAction[] = [
    { id: "add-image", label: "加一张图" },
    { id: "copy-body", label: note.bodyLabel },
    { id: "history", label: "历史版本" },
    {
      id: "toggle-private",
      label: note.isPrivate ? "取消私密" : "标记私密",
    },
  ];
  if (note.canCollapse) {
    items.push({
      id: "toggle-collapse",
      label: note.collapsed ? "展开回正文" : "收起为标题栏",
    });
  }
  items.push({ id: "delete-note", label: "删除便签", danger: true });
  return items;
}

const SEPARATOR: MenuAction = { id: "separator", label: "" };

export function menuFor(hit: MenuHit, note: NoteState): MenuAction[] {
  const head: MenuAction[] = [];
  switch (hit.kind) {
    case "text":
      if (hit.selected.trim() === "") break;
      head.push({ id: "copy-selection", label: "复制选中文字" });
      // 只有对得上正文区间的选中才给"变成链接"：包链接是改正文的动作，位置算不准就不该提供
      if (hit.range !== null) {
        head.push({ id: "add-link", label: "把选中变成链接" });
      }
      break;
    case "row":
      // 条内包链接与正文同一套：区间是那条自己的，包出来的那句 `[字](地址)` 也只有那条认
      if (hit.selected.trim() === "") break;
      head.push(
        { id: "add-link", label: "把选中变成链接" },
        { id: "copy-selection", label: "复制选中" },
      );
      break;
    case "link":
      head.push(
        { id: "open-link", label: "打开链接" },
        { id: "copy-link", label: "复制链接地址" },
      );
      break;
    case "remoteImage":
      head.push(
        { id: "open-link", label: "在浏览器里打开" },
        { id: "copy-link", label: "复制图片地址" },
      );
      break;
    case "image":
      head.push({ id: "copy-image", label: "复制图片" });
      if (note.canDeleteImage) {
        head.push({ id: "delete-image", label: "删掉这张图", danger: true });
      }
      break;
    case "editor":
      // 不给"粘贴"：那要 clipboard-read 权限，WebView2 上常常拿不到（引插件才能稳）
      if (hit.range.end > hit.range.start) {
        head.push(
          { id: "add-link", label: "把选中变成链接" },
          { id: "copy-selection", label: "复制选中" },
          { id: "cut-selection", label: "剪切选中" },
        );
      }
      head.push({ id: "select-all", label: "全选" });
      break;
    case "note":
      break;
  }
  if (head.length === 0) return commonTail(note);
  return [...head, SEPARATOR, ...commonTail(note)];
}
