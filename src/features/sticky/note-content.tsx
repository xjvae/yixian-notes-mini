// NoteContent — 便签内容渲染的**唯一**实现：类型切换、标题、四类内容体、
// 标签、失败反馈、私密遮罩、页脚动作。单窗与叠窗都渲染它，谁也不许自己抄一份。
//
// 正文是**两态**的：默认阅读态（body-view 画识别出来的链接/代码/图），点进去是编辑态
// （一个 textarea，maxLength 仍是 BODY_MAX）。为什么要两态：富内容渲染不进 textarea，
// 而 textarea 才是"打字不会出乱子"的那一个。两态读同一份 note.body，没有第二份真相。
//
// 窗级动作（收起/贴边收纳）不住在这儿了——它们和叠窗一起统一到标题条右侧
// （`WindowChrome` 的 trailing 槽）；删除动作经 `onDelete` 由宿主决定（单窗=删并关窗，
// 叠窗=删并翻页）。
// 遮罩态（私密未解锁）也在这里处理：真身不在内存，标题/正文/标签区整体换锁面。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ImagePlus, Lock, LockOpen, Maximize2, Minimize2, Trash2 } from "lucide-react";
import { TYPE_ICONS } from "@/features/sticky/note-icons";
import { IconPicker } from "@/features/sticky/icon-picker";
import { BodyView } from "@/features/sticky/body-view";
import { forgetMedia } from "@/features/sticky/use-media";
import { ContextMenu } from "@/ui/context-menu";
import { LinkPrompt } from "@/ui/link-prompt";
import { menuFor } from "@/features/sticky/note-menu";
import { selectionRange } from "@/features/sticky/selection-range";
import type { SelectionRange } from "@/features/sticky/selection-range";
import { parseBodySpans, wrapLink } from "@/data/body-parse";
import type { RowRef } from "@/features/sticky/row-target";
import { patchRowText, rowRefFrom, rowRoom, rowText } from "@/features/sticky/row-target";
import type { MenuAction, MenuActionId, MenuHit } from "@/features/sticky/note-menu";
import { openExternal } from "@/platform/open-link";
import { useAutoSizeDefault } from "@/data/auto-size-default";
import { themeColors, themeOf, THEME_KEYS } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { conversionPatch } from "@/data/note-convert";
import {
  bodyActionLabel,
  noteTypeLabel,
  NOTE_TYPE_ORDER,
  plainBody,
} from "@/data/note-types";
import { describeDue } from "@/data/due";
import { BODY_MAX, ITEM_MAX, shouldShowCount } from "@/data/limit";
import { withoutMediaRef } from "@/data/body-parse";
import { isAcceptedMime } from "@/data/image-input";
import { normalizeTagInput, tagInk } from "@/data/tags";
import { useNow } from "@/features/sticky/use-now";
import { useNoteImageAttacher } from "@/features/sticky/use-note-image";
import { TodoBody } from "@/features/sticky/todo-body";
import { TimelineBody } from "@/features/sticky/timeline-body";
import { ReminderFields } from "@/features/sticky/reminder-fields";
import { isMasked, usePrivateState } from "@/data/private-state";
import { useWriteFailures } from "@/store/hooks";
import { updateNote } from "@/store/notes-store";
import {
  mediaDelete,
  mediaGet,
  mediaSetPrivate,
  openUnlockWindow,
} from "@/platform/commands";
import { describeError } from "@/platform/errors";
import { logger } from "@/platform/logger";
import type { StickyContentType, StickyNote } from "@/platform/contracts";

const SCOPE = "sticky";

export interface NoteContentProps {
  id: string;
  note: StickyNote;
  /** 页脚最前面的槽：归组菜单。单窗与叠窗都传——叠窗里也得能把手里这张移出去 */
  leadingActions?: ReactNode;
  /** 收起为标题栏。右键菜单里也有这一项，所以得拿到函数而不只是那个钮
   * （那颗**钮**不住在这儿了——它和叠窗那颗统一到标题条右侧） */
  onCollapse?: () => void;
  onDelete: () => void;
}

export function NoteContent({
  id,
  note,
  leadingActions,
  onCollapse,
  onDelete,
}: NoteContentProps) {
  const failures = useWriteFailures();
  const now = useNow();
  const { resolved } = useScheme();
  const priv = usePrivateState();

  const theme = themeColors(note.theme, resolved);
  const due = describeDue(note.dueAt, note.doneAt, now);
  const showDueBadge =
    note.contentType === "reminder" && due.state !== "none" && due.state !== "done";
  const dueUrgent = due.state === "overdue" || due.state === "today";
  const masked = isMasked(note, priv);

  // 自动长高的三态：null 跟随全局 / true 强制开着 / false 强制固定。
  // 点一下按 null → true → false → null 转一圈：压成两态就丢了"跟随全局"那一档，
  // 而那是全局开关唯一的全局出口（不然开了全局就再也关不掉单张的跟随）
  const autoDefault = useAutoSizeDefault();
  const autoEffective = note.autoSize ?? autoDefault;
  const autoNext = note.autoSize === null ? true : note.autoSize === false ? null : false;
  const autoLabel =
    note.autoSize === null
      ? `自动长高：跟随全局（现在${autoDefault ? "开着" : "关着"}）`
      : note.autoSize
        ? "自动长高：这张强制开着"
        : "自动长高：这张是手拉的固定尺寸";

  // —— 正文两态与图片 ——
  // 阅读态画识别结果（链接/代码/图），编辑态还是那个 textarea：富内容渲染不进 textarea，
  // 而 textarea 才是"打字不会出乱子"的那一个。两态共用同一份 note.body，没有第二份真相。
  const [editingBody, setEditingBody] = useState(false);
  const [bodyMessage, setBodyMessage] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 压图与存库那一段只有一个口：清单条目、时间轴条目走的是同一个（use-note-image） */
  const images = useNoteImageAttacher(id);

  // 进编辑态就把手放到 textarea 上：不聚焦的话"点正文开始写"要点两下
  useEffect(() => {
    if (editingBody) bodyRef.current?.focus();
  }, [editingBody]);

  /** 存好之后把引用插进正文的光标处（不在编辑态就插到末尾） */
  const attachToBody = async (files: File[]): Promise<void> => {
    const caret = editingBody
      ? (bodyRef.current?.selectionStart ?? note.body.length)
      : note.body.length;
    const { refs, ids } = await images.attach(files, {
      room: BODY_MAX - note.body.length,
      isPrivate: note.private,
    });
    if (refs.length === 0) return;
    const block = refs.join("\n");
    const head = note.body.slice(0, caret);
    const tail = note.body.slice(caret);
    const joined =
      head +
      (head === "" || head.endsWith("\n") ? "" : "\n") +
      block +
      (tail === "" ? "\n" : tail.startsWith("\n") ? "" : "\n") +
      tail;
    if (joined.length > BODY_MAX) {
      // 预算没拦住（正文里已有内容比估的挤）。这里**不能** slice 截断：截一半等于把
      // `![…](media://m…)` 切成一句认不出来的残句——图躺在库里却永远显示不出来。
      // 宁可把刚存的删掉，回一句"放不下"
      for (const mediaId of ids) {
        void mediaDelete(mediaId).catch((error: unknown) =>
          logger.caught(SCOPE, "回滚刚存的图失败（正文放不下）", error),
        );
      }
      setBodyMessage(`正文放不下这些图片引用（还差 ${joined.length - BODY_MAX} 个字）`);
      return;
    }
    updateNote(id, { body: joined });
  };

  /**
   * 阅读态里"删掉这张图"：库里的字节与那句引用一起走。
   * `row` 给了就是清单/时间轴那一条里的图 —— 摘的是那一条的文本，不是正文
   * （同一条引用在两边都可能出现，所以必须按目标摘，别按正文一把梭）。
   */
  const dropImage = (mediaId: string, row: RowRef | null = null): void => {
    const target = row === null ? note.body : rowText(note, row);
    if (target === null) return;
    const patch =
      row === null
        ? { body: withoutMediaRef(target, mediaId) }
        : patchRowText(note, row, withoutMediaRef(target, mediaId));
    if (patch === null) return;
    updateNote(id, patch);
    forgetMedia(mediaId);
    void mediaDelete(mediaId).catch((error: unknown) =>
      logger.caught(SCOPE, "删图库里的字节失败（引用已摘）", error),
    );
  };

  /**
   * 把图存好并追加到某一条末尾 —— 与清单/时间轴自己那条粘图的路同一条口径
   * （`room` 先算、放不下就回滚刚存的字节、空条不垫前导换行）。
   */
  const attachToRow = async (row: RowRef, files: File[]): Promise<void> => {
    const current = rowText(note, row);
    if (current === null) return;
    const { refs, ids } = await images.attach(files, {
      room: rowRoom(current),
      isPrivate: note.private,
    });
    if (refs.length === 0) return;
    const block = refs.join("\n");
    const next = current === "" ? block : `${current}\n${block}`;
    if (next.length > ITEM_MAX) {
      for (const mediaId of ids) {
        void mediaDelete(mediaId).catch((error: unknown) =>
          logger.caught(SCOPE, "回滚刚存的图失败（这条放不下）", error),
        );
      }
      setBodyMessage(`这条放不下这些图片引用（还差 ${next.length - ITEM_MAX} 个字）`);
      return;
    }
    const patch = patchRowText(note, row, next);
    if (patch === null) return;
    updateNote(id, patch);
  };

  /** 私密标记翻面。页脚那个钮与右键菜单走的是同一条，别写两份 */
  const togglePrivate = useCallback((): void => {
    if (note.private && (priv.active ? priv.unlocked : true)) {
      updateNote(id, { private: false });
      // 正文被搬出封套，图也要搬回来：media_set_private 只重过密文，
      // id 不变，所以正文里那句 media:// 引用一个字都不用改
      void mediaSetPrivate(id, false).catch((error: unknown) =>
        logger.caught(SCOPE, "把私密图搬回明文失败（内容仍在库里）", error),
      );
      return;
    }
    if (!note.private && priv.active && priv.unlocked) {
      updateNote(id, { private: true });
      void mediaSetPrivate(id, true).catch((error: unknown) =>
        logger.caught(SCOPE, "加密这张便签的图失败（图仍是明文）", error),
      );
      return;
    }
    // 私密层还没配 / 没解锁：先开口令窗，这一次不翻面
    void openUnlockWindow().catch((error: unknown) =>
      logger.caught(SCOPE, "开口令窗失败", error),
    );
  }, [id, note.private, priv.active, priv.unlocked]);

  // —— 右键菜单 ——
  // 命中什么就给什么（判定在 note-menu.ts，纯函数），尾巴那五项不分对象一律给。
  // 叠窗里也照给，只是没有"收起为标题栏"那一档（onCollapse 不传）。
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    actions: MenuAction[];
    hit: MenuHit;
  } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  /** 右键"把选中变成链接"的第二步：就地填地址的那一小块 */
  const [linkDraft, setLinkDraft] = useState<{
    x: number;
    y: number;
    selected: string;
    /** 区间是**目标文本**里的区间：正文或那一条自己，看 row */
    range: { start: number; end: number };
    /** null = 目标是正文 */
    row: RowRef | null;
  } | null>(null);
  /**
   * 右键那一下落在哪一条（"加一张图"要用）。选文件是异步的，回来时菜单早关了，
   * 所以这个目标要单独记住，不能等用时再读 `menu`。
   */
  const imageRowRef = useRef<RowRef | null>(null);
  /** 地址被拒的那句话，写在那一小块输入框下面（它还在问，回执就得还在旁边） */
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash]);

  /** 这句引用在正文里，才给"删掉这张图"（条目里的引用不在 body 上） */
  const bodyHas = (mediaId: string): boolean => note.body.includes(`media://${mediaId}`);

  /**
   * 选中的那几个字落在正文的哪一段。只有一条路：读 `rich-text` 画纯文本时留在 DOM 上的
   * `data-start` / `data-end`（见 `selection-range.ts` 为什么不能拿渲染后的字数反推）。
   */
  const selectedRange = (
    root: Element,
    selection: Selection | null,
  ): SelectionRange | null =>
    selectionRange(
      selection,
      root.querySelector<HTMLElement>("[data-body-content]"),
      note.body,
      parseBodySpans(note.body),
    );

  const openMenu = (
    x: number,
    y: number,
    hit: MenuHit,
    seg: HTMLElement | null = null,
  ): void => {
    setMenu({
      x,
      y,
      hit,
      actions: menuFor(hit, {
        isPrivate: note.private,
        collapsed: note.collapsed,
        canCollapse: onCollapse !== undefined,
        // 手里那张图的那句引用**在目标文本里**才给删：目标可能是正文，也可能是
        // 清单/时间轴的某一条（同一条 media:// 在两边都可能存在，按正文一把梭会摘错地方）
        canDeleteImage:
          hit.kind === "image" &&
          seg !== null &&
          (hit.row === null
            ? bodyHas(hit.mediaId)
            : (rowText(note, hit.row) ?? "").includes(`media://${hit.mediaId}`)),
        bodyLabel: bodyActionLabel(note),
      }),
    });
  };

  /**
   * 这一记右键归谁。true = 我们的菜单（调用方要 `preventDefault`），false = 交回系统菜单。
   * 判在 target 上：标题框与清单/时间轴每条那个 input 照旧走原生（那儿的粘贴/拼写
   * 我们给不了，也没必要给）。正文那块 textarea **一律接管**（作者要了第二次）：
   * 没选区时菜单里就只剩「全选」+ `note-menu.ts` 里那串通用项（条数别在这里抄，
   * 那边加一条这边就过期），粘贴请继续用 Ctrl+V。
   *
   * 入参写成结构而不是 `ReactMouseEvent`：同一段判据既要从 React 的 `contextmenu`
   * 走，也要从窗口上那拍更早的 `pointerup` 走（见下面 `poppedOnRef` 那条注释）。
   */
  const takeOverContext = (event: {
    target: EventTarget | null;
    currentTarget: Element;
    clientX: number;
    clientY: number;
  }): boolean => {
    const node = event.target instanceof HTMLElement ? event.target : null;
    const area = bodyRef.current;
    if (node !== null && area !== null && node === area) {
      const start = area.selectionStart ?? 0;
      const end = area.selectionEnd ?? 0;
      openMenu(event.clientX, event.clientY, {
        kind: "editor",
        selected: note.body.slice(start, end),
        range: { start, end },
      });
      return true;
    }
    if (node !== null && node.closest("input, textarea, select") !== null) return false;
    const seg = node?.closest<HTMLElement>("[data-seg]") ?? null;
    // 落在清单条目/时间轴记录上？那一行自己就是一块文本，目标是它而不是正文
    const rowEl = node?.closest<HTMLElement>("[data-row-id]") ?? null;
    const row = rowRefFrom(rowEl?.dataset.rowKind ?? null, rowEl?.dataset.rowId ?? null);
    const selection = window.getSelection();
    // 认的是 Range 里那几个字，不是 Selection.toString()：后者在文档没焦点时给空串（预览台撞到过）
    const selected =
      selection !== null && selection.rangeCount > 0
        ? selection.getRangeAt(0).toString()
        : "";
    let hit: MenuHit;
    if (seg?.dataset.seg === "image") {
      hit = { kind: "image", mediaId: seg.dataset.media ?? "", row };
    } else if (seg?.dataset.seg === "remote-image") {
      hit = { kind: "remoteImage", href: seg.dataset.href ?? "" };
    } else if (seg?.dataset.seg === "link") {
      hit = { kind: "link", href: seg.dataset.href ?? "" };
    } else if (row !== null && rowEl !== null && selected.trim() !== "") {
      const text = rowText(note, row);
      const range =
        text === null
          ? null
          : selectionRange(selection, rowEl, text, parseBodySpans(text));
      hit =
        range === null
          ? { kind: "text", selected, range: null }
          : { kind: "row", row, selected, range };
    } else if (selected.trim() !== "") {
      hit = {
        kind: "text",
        selected,
        range: selectedRange(event.currentTarget, selection),
      };
    } else {
      hit = { kind: "note" };
    }
    openMenu(event.clientX, event.clientY, hit, seg);
    return true;
  };

  /**
   * `pointerup` 那一拍（比 `mouseup` 还早，更早于 `contextmenu`）就把菜单弹出来，
   * 记下的坐标用来让随后那个 `contextmenu` 只挡系统菜单、不再重弹一次。
   * **为什么不等到 `contextmenu`**：可编辑区里 Chromium 要先把**它自己的**菜单准备好
   * 才派发那个事件，作者量的"有延迟"就是那一段——我们这侧从事件到菜单出现只有 0.4ms
   * （4920 字正文里同步画完），所以能做的就是把弹菜单挪到那段等待之前。
   *
   * 挂在 window 的 capture 上而不是写成 JSX 的 `onMouseUp`：a11y 规则不许在普通 div
   * 上挂鼠标处理器（这层壳是正文 + 页脚的容器，不是按钮），而 `ContextMenu` 关自己
   * 走的也是同一条 capture 监听。
   */
  const shellRef = useRef<HTMLDivElement>(null);
  const poppedOnRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onPointerUp = (event: PointerEvent): void => {
      if (event.button !== 2) return;
      const shell = shellRef.current;
      if (shell === null || !shell.contains(event.target as Node)) return;
      const taken = takeOverContext({
        target: event.target,
        currentTarget: shell,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (taken) poppedOnRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointerup", onPointerUp, true);
    return () => window.removeEventListener("pointerup", onPointerUp, true);
  });

  const onContextMenu = (event: ReactMouseEvent): void => {
    const popped = poppedOnRef.current;
    poppedOnRef.current = null;
    if (popped !== null && popped.x === event.clientX && popped.y === event.clientY) {
      event.preventDefault();
      return;
    }
    // 没有 preceding pointerup 的那一下 = 键盘唤起的菜单（Shift+F10），同样接管
    if (takeOverContext(event)) event.preventDefault();
  };

  const copy = async (text: string, said: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setFlash(said);
    } catch (error) {
      setFlash(`没复制成：${describeError(error)}`);
    }
  };

  /**
   * 剪切选中：**先复制，复制成了才删**。
   * 反过来做的话，系统不给剪贴板那一下用户的字就凭空少了几个——而这正是这一档菜单
   * 里没有"粘贴"的同一个理由（`clipboard-read` 在 WebView2 上不稳，作者拍板不引插件）。
   * 失败就原样留着并说清。
   */
  const cutSelection = async (range: { start: number; end: number }): Promise<void> => {
    const text = note.body.slice(range.start, range.end);
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      setFlash(`没剪切：复制没成，所以你的字还在（${describeError(error)}）`);
      return;
    }
    updateNote(id, {
      body: note.body.slice(0, range.start) + note.body.slice(range.end),
    });
    setFlash("已剪切");
    bodyRef.current?.focus();
  };

  const copyImage = async (mediaId: string): Promise<void> => {
    try {
      const bytes = await mediaGet(mediaId);
      if (bytes === null) {
        setFlash("这张图已经不在库里了");
        return;
      }
      const blob = await (
        await fetch(`data:${bytes.mime};base64,${bytes.dataBase64}`)
      ).blob();
      await navigator.clipboard.write([new ClipboardItem({ [bytes.mime]: blob })]);
      setFlash("图片已复制");
    } catch (error) {
      // 剪贴板写图这件事 WebView2 支持，但用户没给焦点或格式不支持时会失败——如实说
      setFlash(`没复制成图片：${describeError(error)}`);
    }
  };

  const pickMenu = (action: MenuActionId): void => {
    const anchor = menu;
    const hit = menu?.hit;
    setMenu(null);
    switch (action) {
      case "copy-selection":
        if (hit?.kind === "text" || hit?.kind === "editor" || hit?.kind === "row") {
          void copy(hit.selected, "已复制选中文字");
        }
        break;
      case "cut-selection":
        if (hit?.kind === "editor") void cutSelection(hit.range);
        break;
      case "select-all":
        bodyRef.current?.setSelectionRange(0, note.body.length);
        bodyRef.current?.focus();
        break;
      case "add-link": {
        // 菜单先收掉，就地接着弹那一小块填地址的 —— 手指不用在两个东西之间跳。
        // 三种目标都走这一个口：阅读态正文（区间来自 DOM 上留的 data-start）、
        // 编辑态正文（textarea 的 selectionStart/End）、清单/时间轴那一条（那条自己的区间）
        if (anchor === null) break;
        if (hit?.kind === "editor") {
          setLinkDraft({
            x: anchor.x,
            y: anchor.y,
            selected: hit.selected,
            range: hit.range,
            row: null,
          });
        } else if (hit?.kind === "row") {
          setLinkDraft({
            x: anchor.x,
            y: anchor.y,
            selected: hit.selected,
            range: hit.range,
            row: hit.row,
          });
        } else if (hit?.kind === "text" && hit.range !== null) {
          setLinkDraft({
            x: anchor.x,
            y: anchor.y,
            selected: hit.selected,
            range: hit.range,
            row: null,
          });
        }
        break;
      }
      case "copy-body": {
        // 复制的是**这一块文本**，四类便签存在不同字段里（见 plainBody）。
        // 回执直接跟着菜单上那句走："已复制清单 / 已复制时间轴 / 已复制正文"
        const text = plainBody(note);
        const label = bodyActionLabel(note);
        void copy(text, text === "" ? "这块还是空的" : `已${label}`);
        break;
      }
      case "copy-link":
        if (hit?.kind === "link" || hit?.kind === "remoteImage")
          void copy(hit.href, "已复制链接");
        break;
      case "open-link":
        if (hit?.kind === "link" || hit?.kind === "remoteImage") {
          void openExternal(hit.href).catch((error: unknown) =>
            logger.caught(SCOPE, "打开链接失败", error),
          );
        }
        break;
      case "copy-image":
        if (hit?.kind === "image") void copyImage(hit.mediaId);
        break;
      case "delete-image":
        // 图在正文还是在某一条里，摘引用的地方跟着走
        if (hit?.kind === "image") dropImage(hit.mediaId, hit.row);
        break;
      case "add-image":
        // 记下目标那一条：选完文件回来时菜单早关了，只能靠这份（null = 加进正文）
        imageRowRef.current = hit?.kind === "row" ? hit.row : null;
        fileRef.current?.click();
        break;
      case "toggle-private":
        togglePrivate();
        break;
      case "toggle-collapse":
        onCollapse?.();
        break;
      case "delete-note":
        onDelete();
        break;
      case "separator":
        break;
    }
  };

  /** 地址填完了：改的是正文那一段，别的一个字都不动（放不下的话整句不写） */
  const applyLink = (url: string): void => {
    const draft = linkDraft;
    if (draft === null) return;
    // 目标是清单/时间轴那一条时，上限按条目算（200）：一句图引用就占 ~28 字，
    // 正文那 5000 的余量在一条里是不存在的
    const target = draft.row === null ? note.body : rowText(note, draft.row);
    if (target === null) return;
    const result = wrapLink(
      target,
      draft.range.start,
      draft.range.end,
      url,
      draft.row === null ? BODY_MAX : ITEM_MAX,
    );
    if (!result.ok) {
      // **不关**：地址不对是他还没打完，关掉等于把他打的两个字清掉、从头再来一遍。
      // 理由也只写在这一小块上——它在问地址，回执跑到正文底下就看不见
      setLinkError(result.reason);
      return;
    }
    const patch =
      draft.row === null
        ? { body: result.body }
        : patchRowText(note, draft.row, result.body);
    if (patch === null) return;
    setLinkDraft(null);
    setLinkError(null);
    updateNote(id, patch);
    setFlash("链接加好了");
  };

  const switchType = (to: StickyContentType): void => {
    updateNote(id, conversionPatch(note, to));
  };

  const addTag = (raw: string): void => {
    const name = normalizeTagInput(raw, note.tags);
    if (name !== null) updateNote(id, { tags: [...note.tags, name] });
  };

  const dueBadge = showDueBadge ? (
    <span
      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        backgroundColor: dueUrgent ? theme.accent : "rgba(0,0,0,0.06)",
        color: dueUrgent ? "#fff" : theme.ink,
      }}
    >
      {due.text}
    </span>
  ) : null;

  if (masked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Lock size={22} aria-hidden style={{ color: theme.accent }} />
        <p className="text-xs font-medium" style={{ color: theme.ink }}>
          已锁定 · 私密便签
        </p>
        <button
          type="button"
          onClick={() =>
            void openUnlockWindow().catch((error: unknown) =>
              logger.caught(SCOPE, "开口令窗失败", error),
            )
          }
          className="rounded-md px-4 py-1.5 text-xs font-medium transition-opacity hover:opacity-80"
          style={{ backgroundColor: theme.accent, color: theme.paper }}
        >
          解锁
        </button>
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            aria-label="删除便签"
            title="删除（可在回收站恢复）"
            onClick={onDelete}
            className="rounded p-1 transition-colors hover:bg-black/10"
            style={{ color: theme.accent }}
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className="flex h-full flex-col gap-1.5 p-3"
      onContextMenu={onContextMenu}
      /*
       * 滚动条跟着这张纸的颜色走：两个变量写在根上，这一屏所有滚容器共用
       * （读它们的是 index.css 里那段 ::-webkit-scrollbar）。写在这里而不是各滚
       * 容器各配一份，是因为"这张纸是什么色"只有一个来源——themeColors 那一次算。
       */
      style={
        {
          "--nb-ink": theme.ink,
          "--nb-accent": theme.accent,
        } as CSSProperties
      }
    >
      {/* 类型切换 + 六色 */}
      <div
        className="flex shrink-0 items-center gap-0.5"
        role="group"
        aria-label="便签类型"
      >
        {NOTE_TYPE_ORDER.map((type) => {
          const Icon = TYPE_ICONS[type];
          const active = note.contentType === type;
          return (
            <button
              key={type}
              type="button"
              aria-label={`转为${noteTypeLabel(type)}`}
              aria-pressed={active}
              title={`转为${noteTypeLabel(type)}`}
              onClick={() => switchType(type)}
              className="rounded p-1 transition-colors"
              style={{
                color: active ? theme.accent : theme.ink,
                backgroundColor: active ? "rgba(0,0,0,0.07)" : "transparent",
                opacity: active ? 1 : 0.45,
              }}
            >
              <Icon size={14} aria-hidden />
            </button>
          );
        })}
        <div className="flex-1" />
        {dueBadge}
        <div role="group" aria-label="便签颜色" className="flex items-center gap-1">
          {THEME_KEYS.map((key) => {
            const dot = themeOf(key);
            const active = key === note.theme;
            return (
              <button
                key={key}
                type="button"
                aria-label={`换成${dot.name}`}
                aria-pressed={active}
                title={dot.name}
                onClick={() => updateNote(id, { theme: key })}
                className="h-3.5 w-3.5 rounded-full border transition-transform hover:scale-110"
                style={{
                  backgroundColor: dot.paper,
                  borderColor: active ? dot.accent : "rgba(0,0,0,0.15)",
                  boxShadow: active ? `0 0 0 2px ${dot.accent}55` : "none",
                }}
              />
            );
          })}
        </div>
      </div>

      {/* 标题 */}
      <input
        aria-label="便签标题"
        value={note.title}
        maxLength={40}
        placeholder="标题"
        onChange={(event) => updateNote(id, { title: event.target.value })}
        className="shrink-0 bg-transparent text-sm font-semibold"
        style={{ color: theme.ink }}
      />

      {/* 内容体 */}
      {note.contentType === "todo" ? (
        <TodoBody
          items={note.items}
          ink={theme.ink}
          accent={theme.accent}
          attach={images.attach}
          isPrivate={note.private}
          onChange={(items) => updateNote(id, { items })}
        />
      ) : note.contentType === "timeline" ? (
        <TimelineBody
          entries={note.timeline}
          ink={theme.ink}
          accent={theme.accent}
          attach={images.attach}
          isPrivate={note.private}
          onChange={(timeline) => updateNote(id, { timeline })}
        />
      ) : (
        <>
          {note.contentType === "reminder" && (
            <ReminderFields
              dueAt={note.dueAt}
              doneAt={note.doneAt}
              repeat={note.repeat}
              ink={theme.ink}
              accent={theme.accent}
              onChange={(patch) => updateNote(id, patch)}
            />
          )}
          {/* 正文：阅读态画识别结果，编辑态是 textarea。拖图两态都收（外面这层壳
              就是为这个存在的——只挂在 textarea 上的话，看着图想拖一张进来反而拖不进） */}
          <div
            className="flex min-h-0 flex-1 flex-col"
            onDragOver={(event) => {
              if (
                [...event.dataTransfer.files].some((file) => isAcceptedMime(file.type))
              ) {
                event.preventDefault();
              }
            }}
            onDrop={(event) => {
              const files = [...event.dataTransfer.files];
              if (!files.some((file) => isAcceptedMime(file.type))) return;
              event.preventDefault();
              void attachToBody(files);
            }}
          >
            {editingBody ? (
              <textarea
                ref={bodyRef}
                data-body-slot=""
                aria-label="便签正文（编辑中）"
                value={note.body}
                maxLength={BODY_MAX}
                placeholder="写点什么…　链接、``` 代码会被认出来，图片可以粘贴或拖进来"
                onChange={(event) => updateNote(id, { body: event.target.value })}
                onBlur={() => setEditingBody(false)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    bodyRef.current?.blur();
                  }
                }}
                onPaste={(event) => {
                  const files = [...event.clipboardData.files];
                  if (files.some((file) => isAcceptedMime(file.type))) {
                    // 剪贴板里有图就按图办：不拦的话浏览器粘进来的是文件名或一串
                    // 指向本机的路径，看着像粘成功了，其实什么图都没有
                    event.preventDefault();
                    void attachToBody(files);
                  }
                }}
                className="min-h-0 w-full flex-1 resize-none bg-transparent text-[13px] leading-relaxed"
                style={{ color: theme.ink }}
              />
            ) : (
              <BodyView
                body={note.body}
                ink={theme.ink}
                accent={theme.accent}
                onEdit={() => setEditingBody(true)}
                onDeleteImage={dropImage}
              />
            )}
            {images.busy && (
              <p role="status" className="shrink-0 text-[11px] opacity-50">
                正在压这张图…
              </p>
            )}
            {(bodyMessage ?? images.message) !== null && (
              <p role="alert" className="shrink-0 text-[11px] text-red-700">
                {bodyMessage ?? images.message}
              </p>
            )}
          </div>
        </>
      )}

      {/* 写入失败反馈条 */}
      {failures.length > 0 && (
        <div
          role="status"
          className="shrink-0 rounded px-2 py-1 text-[11px]"
          style={{ backgroundColor: "#FEE2E2", color: "#991B1B" }}
        >
          有改动还没写进磁盘，会自动重试
        </div>
      )}

      {/* 页脚分两行，各管各的：
          上 = 这张纸的元信息（归组槽 / 标签 / 字数），标签能有好几个，这一行**允许换行**；
          下 = 窗级动作那一排按钮，**单独一行、不换行**。
          以前两拨挤在一排 `flex-wrap` 里：预览台量过，连默认的 318 宽都摆不下，
          按钮被折到两三条线上（5 个 top、~50px 高），作者要的就是这个"按钮单独一列"。
          不换行不等于塞得下——窄窗下真溢出就是"最后一枚按钮按不到"（M6 当初加 flex-wrap
          正是为了它），所以这一行的宽度在预览台按 220 / 318 / 520 三档量过。 */}
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {leadingActions}
          {note.tags.map((tag) => {
            const chipInk = tagInk(tag);
            return (
              <span
                key={tag}
                className="flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px]"
                style={{ backgroundColor: chipInk.background, color: chipInk.ink }}
              >
                {tag}
                <button
                  type="button"
                  aria-label={`摘掉标签「${tag}」`}
                  onClick={() =>
                    updateNote(id, { tags: note.tags.filter((name) => name !== tag) })
                  }
                  className="opacity-40 transition-opacity hover:opacity-100"
                >
                  ×
                </button>
              </span>
            );
          })}
          <input
            aria-label="添加标签"
            placeholder="+ 标签"
            maxLength={20}
            className="w-16 rounded-full bg-black/5 px-2 py-0.5 text-[10px] placeholder:text-black/30"
            style={{ color: theme.ink }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                addTag(event.currentTarget.value);
                event.currentTarget.value = "";
              }
            }}
            onBlur={(event) => {
              addTag(event.currentTarget.value);
              event.currentTarget.value = "";
            }}
          />
          <div className="flex-1" />
          {shouldShowCount(note.body.length, BODY_MAX) && (
            <span className="text-[10px] opacity-40" style={{ color: theme.ink }}>
              {note.body.length}/{BODY_MAX}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* 加图。走 webview 自己的文件框，不需要 fs/dialog 插件：拿到的就是 File 对象，
            字节随后由 media_save 落库 */}
          <button
            type="button"
            aria-label="加一张图（也可以直接粘贴或拖进来）"
            title="加一张图（也可以直接粘贴或拖进来）"
            onClick={() => fileRef.current?.click()}
            className="rounded p-1 transition-colors hover:bg-black/10"
            style={{ color: theme.accent }}
          >
            <ImagePlus size={14} aria-hidden />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            multiple
            className="hidden"
            aria-label="选图加进便签"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              // 清掉 value：不然同一张图连选两次不会触发 change（用户只会觉得"没反应"）
              event.target.value = "";
              const row = imageRowRef.current;
              imageRowRef.current = null;
              // 右键落在哪一条就加进那一条；菜单早关了，靠的是 imageRowRef 那份记号
              if (row !== null) void attachToRow(row, files);
              else void attachToBody(files);
            }}
          />
          <button
            type="button"
            aria-label={autoLabel}
            title={`${autoLabel}（点一下切下一档：跟随全局 → 强制开着 → 强制固定）`}
            onClick={() => updateNote(id, { autoSize: autoNext })}
            className="rounded p-1 transition-colors hover:bg-black/10"
            style={{ color: theme.accent, opacity: note.autoSize === null ? 0.45 : 1 }}
          >
            {autoEffective ? (
              <Maximize2 size={14} aria-hidden />
            ) : (
              <Minimize2 size={14} aria-hidden />
            )}
          </button>
          <IconPicker id={id} note={note} masked={masked} />
          <button
            type="button"
            aria-label={note.private ? "取消私密" : "标记私密"}
            title={note.private ? "取消私密" : "标记私密"}
            onClick={togglePrivate}
            className="rounded p-1 transition-colors hover:bg-black/10"
            style={{ color: theme.accent }}
          >
            {note.private ? (
              <LockOpen size={14} aria-hidden />
            ) : (
              <Lock size={14} aria-hidden />
            )}
          </button>
          <button
            type="button"
            aria-label="删除便签"
            title="删除（可在回收站恢复）"
            onClick={onDelete}
            className="rounded p-1 transition-colors hover:bg-black/10"
            style={{ color: theme.accent }}
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </div>

      {/* 菜单动作的回执：复制成没成、图还在不在。1.8s 自己走，不占地方也不留着挡字 */}
      {flash !== null && (
        <p role="status" className="shrink-0 text-[11px] opacity-70">
          {flash}
        </p>
      )}

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          actions={menu.actions}
          ink={theme.ink}
          accent={theme.accent}
          paper={theme.paper}
          onPick={pickMenu}
          onClose={() => setMenu(null)}
        />
      )}

      {linkDraft !== null && (
        <LinkPrompt
          x={linkDraft.x}
          y={linkDraft.y}
          selected={linkDraft.selected}
          notice={linkError ?? undefined}
          ink={theme.ink}
          accent={theme.accent}
          paper={theme.paper}
          onConfirm={applyLink}
          onCancel={() => {
            setLinkDraft(null);
            setLinkError(null);
          }}
        />
      )}
    </div>
  );
}
