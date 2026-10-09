// 便签右键菜单的判定 — "右键点在什么上"→"该给哪几项"。纯函数，不碰 DOM。
//
// 为什么单独拎出来：菜单项本身是几行 JSX，但"随对象变"这套规则（选中文本给复制、
// 链接给打开+复制、图给复制+删掉，最后都接同一串便签通用项）是最容易改乱的地方。
// 写成纯函数就能把每条分支钉进用例，而不是靠手点五种位置去回忆规则。
//
// 尾巴那五项是**同一串**（作者拍板"随对象变"，但通用项不该跟着目标消失）：
// 加一张图 / 复制正文 / 标记或取消私密 / 收起为标题栏 / 删除便签。
// 收起只在单窗有——叠窗没有标题栏形态，所以 `canCollapse` 由调用方说，这里不猜。
// 危险项（删除便签、删掉这张图）一律排在各自那一段的最后，不让人闭着眼点到。

import type { RowRef } from "@/features/sticky/row-target";

/** 右键落在什么上 */
export type MenuHit =
  /**
   * 选中了正文里的字（selected 非空才算，空选择按 note 处理）。
   * `range` = 这段选中在**正文**里的原文区间；对不上正文（选跨了链接/代码/图）就是
   * null —— 只给复制，不给"变成链接"。
   */
  | { kind: "text"; selected: string; range: { start: number; end: number } | null }
  /**
   * 选中了**某一条**里的字（清单条目、时间轴那条记录）。区间是那条自己的文本区间，
   * 写回也写进那条（见 `row-target.ts` 为什么要抽这一层）。
   */
  | { kind: "row"; row: RowRef; selected: string; range: { start: number; end: number } }
  /**
   * 编辑态那块 textarea 里选中了字（区间直接来自 `selectionStart/End`，天生精确）。
   * 只在**有选区**时才用这一档：空白处右键要留给系统菜单，那儿才是粘贴/撤销/拼写
   * 的地方，我们给不了那几样（作者拍板"不要粘贴，只给不需要读的"）。
   */
  | { kind: "editor"; selected: string; range: { start: number; end: number } }
  | { kind: "link"; href: string }
  /**
   * 本机图库里的图（media:// 那句引用对应的字节）。
   * `row` = 这张图在清单/时间轴的某一条里（null = 在正文里）——决定"删掉这张图"
   * 那句引用要从哪儿摘。
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
   * "复制这一块文本"那一项叫什么。四类便签的正文不在同一个字段（文本/提醒是
   * `body`、清单是 `items[].text`、时间轴是 `timeline[].text`，见
   * `data/note-types.ts` 的 `plainBody`），所以文案得跟着类型走 ——
   * 不然清单上写着"复制正文"、复制出来是空串。
   */
  bodyLabel: string;
}

export type MenuActionId =
  | "copy-selection"
  | "cut-selection"
  | "select-all"
  | "add-link"
  | "open-link"
  | "copy-link"
  | "copy-image"
  | "delete-image"
  | "add-image"
  | "copy-body"
  | "toggle-private"
  | "toggle-collapse"
  | "delete-note"
  | "separator";

export interface MenuAction {
  id: MenuActionId;
  /** 分隔线没有文案 */
  label: string;
  /** 危险项：渲染成红字，且永远排在本段最后 */
  danger?: boolean;
}

/** 通用尾巴。顺序即菜单里的顺序，删除便签在最后 */
function commonTail(note: NoteState): MenuAction[] {
  const items: MenuAction[] = [
    { id: "add-image", label: "加一张图" },
    { id: "copy-body", label: note.bodyLabel },
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
      // 只有对得上正文区间的选中才给"变成链接"：包链接是改正文的动作，
      // 位置算不准就不该提供（选了跨到代码/图/条目上，range 就是 null）
      if (hit.range !== null) {
        head.push({ id: "add-link", label: "把选中变成链接" });
      }
      break;
    case "row":
      // 条目里的选中与正文同一套：区间是那条自己的，包出来的那句 `[字](地址)`
      // 也只有那条认（识别口径本来就和正文是同一份）
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
      // 编辑态这一档：**不给"粘贴"**（那需要 clipboard-read 权限，WebView2 上常常拿不到，
      // 引插件才能稳）。粘贴/撤销/拼写请在这块空白处右键，那是系统菜单的地盘。
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
