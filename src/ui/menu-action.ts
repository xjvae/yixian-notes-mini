// 右键菜单的动作契约（id 联合 + 条目形状），住 ui 层：
// ContextMenu 渲染它，"给哪几项"由 features（note-menu.ts）实现。

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
  | "history"
  | "toggle-private"
  | "toggle-collapse"
  | "delete-note"
  | "separator";

export interface MenuAction {
  id: MenuActionId;
  /** 分隔线没有文案 */
  label: string;
  /** 危险项：红字，排在本段最后 */
  danger?: boolean;
}
