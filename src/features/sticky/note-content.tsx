// NoteContent — 便签内容渲染的**唯一**实现（单窗与叠窗都渲染它，谁也不许自己抄一份）：
// 类型切换、标题、四类内容体、标签、失败反馈、私密遮罩、页脚动作。
// 正文两态：默认阅读态（body-view 画识别出的链接/代码/图），点进去是编辑态 textarea（maxLength=BODY_MAX）。
// 为什么两态：富内容渲染不进 textarea，而 textarea 才是打字不会出乱子的那一个；两态读同一份 note.body，没有第二份真相。
// 遮罩态（私密未解锁）也在这里处理：真身不在内存，标题/正文/标签区整体换锁面。窗级动作归标题条右侧，删除经 onDelete 由宿主决定。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  EyeOff,
  History,
  ImagePlus,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  Trash2,
} from "lucide-react";
import { TYPE_ICONS } from "@/features/sticky/note-icons";
import { IconPicker } from "@/features/sticky/icon-picker";
import { BodyView } from "@/features/sticky/body-view";
import { ContextMenu } from "@/ui/context-menu";
import { HistoryPanel } from "@/features/sticky/history-panel";
import { LinkPrompt } from "@/ui/link-prompt";
import { menuFor } from "@/features/sticky/note-menu";
import { selectionRange } from "@/features/sticky/selection-range";
import type { SelectionRange } from "@/features/sticky/selection-range";
import { parseBodySpans, wrapLink } from "@/data/body-parse";
import type { RowRef } from "@/features/sticky/row-target";
import { patchRowText, rowRefFrom, rowText } from "@/features/sticky/row-target";
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
import { BODY_MAX, ITEM_MAX, TAG_MAX, TITLE_MAX, shouldShowCount } from "@/data/limit";
import { isAcceptedMime } from "@/data/image-input";
import { normalizeTagInput, tagInk } from "@/data/tags";
import { useNow } from "@/features/sticky/use-now";
import { useImageAttach } from "@/features/sticky/use-image-attach";
import { TodoBody } from "@/features/sticky/todo-body";
import { TimelineBody } from "@/features/sticky/timeline-body";
import { ReminderFields } from "@/features/sticky/reminder-fields";
import { isMasked, usePrivateState } from "@/data/private-state";
import { useWriteFailures } from "@/store/hooks";
import { flushNow, updateNote } from "@/store/notes-store";
import {
  mediaGet,
  mediaSetPrivate,
  openUnlockWindow,
  privateLock,
} from "@/platform/commands";
import { lockAfterMark } from "@/data/lock-after-mark";
import { requirePrivateUnlock } from "@/window/private-gate";
import { describeError } from "@/platform/errors";
import { logger } from "@/platform/logger";
import type { StickyContentType, StickyNote } from "@/platform/contracts";

const SCOPE = "sticky";
/** 「要不要立即锁回去」那 5 秒。比回收站/恢复那两处两段确认（3 秒）长一点：那是确认删除，这是顺手一问 */
const LOCK_CONFIRM_MS = 5000;
/** 提示条（flash）自动消失的时长：长到读得完一句话，短到不挡下一波操作 */
const FLASH_MS = 1800;

export interface NoteContentProps {
  id: string;
  note: StickyNote;
  /** 页脚最前面的槽：归组菜单。单窗与叠窗都传——叠窗里也得能把手里这张移出去 */
  leadingActions?: ReactNode;
  /** 收起为标题栏。右键菜单里也有这一项，所以拿到的是函数而不只是按钮。 */
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

  // 自动长高三态 null/true/false（点一下转一圈）；不能压成两态——"跟随全局"那档是关掉全局开关的唯一出口。
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
  const [editingBody, setEditingBody] = useState(false);
  const [bodyMessage, setBodyMessage] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * 贴图三条路（正文插入 / 条目追加 / 按引用删）整簇在 use-image-attach：
   * "预算 → 放不下回滚" 原来在 attachToBody 与 attachToRow 各抄一份，收拢成一份了。
   */

  // 进编辑态就把手放到 textarea 上：不聚焦的话"点正文开始写"要点两下
  useEffect(() => {
    if (editingBody) bodyRef.current?.focus();
  }, [editingBody]);

  const { attachToBody, attachToRow, dropImage, images } = useImageAttach({
    id,
    note,
    editingBody,
    bodyRef,
    onMessage: setBodyMessage,
  });

  /** 走过口令窗标记成私密后"要不要立刻锁回去"的 5 秒确认态。只在真输过口令那条路亮起：
   *  已解锁时点标记的人没输密码，不该被问。 */
  const [lockConfirm, setLockConfirm] = useState(false);
  const lockConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 翻这张的密级，图跟内容走同一密级（media_set_private 只重过密文、id 不变，正文的 media:// 引用不用改）。
   *  这发 Promise 交回调用方、不 fire-and-forget：紧接着可能"立即锁定"，抢在图重加密落定前锁上 → 密钥没了、图永远停明文而行上写着 private=1。
   *  顺序**先图、后内容**：翻回公开时 sticky::upsert 会把密文行和**那张的键行**一起摘掉，键行先没那批图就再也解不开。
   *  图那一发没成就**到此为止**：内容翻过去就等于行上写着私密而图摊着明文，那个标记是假的。 */
  const applyPrivate = useCallback(
    async (want: boolean): Promise<void> => {
      try {
        await mediaSetPrivate(id, want);
      } catch (error: unknown) {
        logger.caught(
          SCOPE,
          want
            ? "加密这张便签的图失败（图仍是明文）"
            : "把私密图搬回明文失败（内容仍在库里）",
          error,
        );
        setBodyMessage(
          want ? "这张的图没加密上，先没标记成私密" : "这张的图没搬回明文，先没翻回公开",
        );
        return;
      }
      setBodyMessage(null);
      updateNote(id, { private: want });
    },
    [id],
  );

  /** 摆出"要不要立即锁回去"那 5 秒；到点自己收，不等他回答 */
  const armLockConfirm = useCallback((): void => {
    if (lockConfirmTimer.current !== null) clearTimeout(lockConfirmTimer.current);
    setLockConfirm(true);
    lockConfirmTimer.current = setTimeout(() => setLockConfirm(false), LOCK_CONFIRM_MS);
  }, []);

  /** 「立即锁定」唯一那条路：**先把在途改动落完、再丢密钥**。少这一步，刚打完不到 250ms 的字会停在内存里——
   *  锁一落包装层只能往行上写空占位，那几个字当场没了。flushNow 自己收失败进在途队列（不抛），落不成也照常锁。 */
  const lockNow = useCallback(async (): Promise<void> => {
    await flushNow();
    await privateLock().catch((error: unknown) =>
      logger.caught(SCOPE, "立即锁定没成", error),
    );
  }, []);

  useEffect(
    () => () => {
      if (lockConfirmTimer.current !== null) clearTimeout(lockConfirmTimer.current);
    },
    [],
  );

  /** 页脚那颗**私密开关**（右键菜单同一回调）。只管翻密级；收回是旁边那颗 EyeOff 的事 */
  const togglePrivate = useCallback((): void => {
    const wantsMark = !note.private;
    // 私密层还没立起来时"翻回公开"没有密可撤：行上本来就摊着明文，直接写就行
    // （反过来"标记成私密"仍要走口令窗——那一发是把口令立起来）
    if (!wantsMark && !priv.active) {
      void applyPrivate(false).catch((error: unknown) =>
        logger.caught(SCOPE, "翻回公开失败", error),
      );
      return;
    }
    // 两个方向都要"这一张开着"：标记私密用它的钥匙封正文，翻公开先把真身读出写明文（读不出=公布空壳丢内容）。
    // 已开着那张走 gate 短路：当场办完、不打断、不问"立即锁回去"（这路没输密码）；只有标记成私密才按设置问。
    void requirePrivateUnlock({
      noteId: id,
      purpose: "reveal",
      action: () => applyPrivate(wantsMark),
      after: wantsMark
        ? async () => {
            const mode = lockAfterMark();
            if (mode === "now") {
              await lockNow();
            } else if (mode === "ask") {
              armLockConfirm();
            }
          }
        : undefined,
      what: wantsMark ? "把这张标记成私密" : "把这张翻回公开",
    }).catch((error: unknown) => logger.caught(SCOPE, "开口令窗失败", error));
  }, [applyPrivate, armLockConfirm, id, lockNow, note.private, priv.active]);

  // —— 右键菜单 ——（命中什么给什么，判定在 note-menu.ts 纯函数；叠窗也照给，只是没"收起"那档）
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    actions: MenuAction[];
    hit: MenuHit;
  } | null>(null);
  /** 「历史版本」那层窗内覆盖开没开（面板本身在 history-panel.tsx） */
  const [historyOpen, setHistoryOpen] = useState(false);
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
  /** 右键落在哪一条（"加一张图"要用）：选文件是异步的，回来时菜单早关了，得单独记住、不能用时再读 `menu`。 */
  const imageRowRef = useRef<RowRef | null>(null);
  /** 地址被拒的那句话，写在那一小块输入框下面（它还在问，回执就得还在旁边） */
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  /** 这句引用在正文里，才给"删掉这张图"（条目里的引用不在 body 上） */
  const bodyHas = (mediaId: string): boolean => note.body.includes(`media://${mediaId}`);

  /** 选中落在正文哪一段，只有一条路：读 rich-text 画纯文本时留在 DOM 上的 data-start/data-end
   *  （见 selection-range.ts 为何不能拿渲染后字数反推）。 */
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

  /** 这一记右键归谁：true=我们的菜单（调用方 preventDefault），false=交回系统。
   *  判在 target：标题/清单/时间轴的 input 走原生（粘贴拼写给不了也不必给），正文 textarea 一律接管；
   *  没选区时只剩「全选」+note-menu.ts 通用项（别在这抄条数）。入参写成结构而非 ReactMouseEvent，因同一判据要从 contextmenu 和更早的 pointerup 两处走。 */
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

  /** `pointerup`（比 mouseup/contextmenu 都早）就弹菜单；记坐标让随后的 contextmenu 只挡系统菜单不重弹。
   *  为何不等 contextmenu：可编辑区里 Chromium 要先备好**它自己的**菜单才派发，那段等待就是延迟来源，所以把弹菜单挪到它之前。
   *  挂 window capture 而非 JSX onMouseUp：a11y 规则不许在普通 div 挂鼠标处理器（这壳是正文+页脚容器不是按钮），ContextMenu 关自己也走同一条 capture。 */
  const shellRef = useRef<HTMLDivElement>(null);
  const poppedOnRef = useRef<{ x: number; y: number } | null>(null);
  // `takeOverContext` 每渲染是一个新闭包（它要用这一拍的 props）。不隔一层 ref，
  // 这个 effect 就只能每渲染重挂一次 window 上的 capture 监听——打字时那是白 churn
  const takeOverContextRef = useRef(takeOverContext);
  useEffect(() => {
    takeOverContextRef.current = takeOverContext;
  });

  useEffect(() => {
    const onPointerUp = (event: PointerEvent): void => {
      if (event.button !== 2) return;
      const shell = shellRef.current;
      if (shell === null || !shell.contains(event.target as Node)) return;
      const taken = takeOverContextRef.current({
        target: event.target,
        currentTarget: shell,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (taken) poppedOnRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointerup", onPointerUp, true);
    return () => window.removeEventListener("pointerup", onPointerUp, true);
  }, []);

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

  /** 剪切选中：**先复制、复制成了才删**——反过来做，系统不给剪贴板那下用户的字就凭空少了几个。
   *  失败就原样留着并说清。（这也是本菜单没"粘贴"的原因：clipboard-read 在 WebView2 不稳，不引插件。） */
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
        // 菜单先收、就地弹那一小块填地址的（手指不用在两个东西间跳）；正文/编辑态/条目三种目标都走这一个口
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
        // 复制的是**这一块文本**，四类便签存在不同字段里（见 plainBody）；回执跟着菜单上那句走
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
      case "history":
        setHistoryOpen(true);
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
    // 目标是清单/时间轴那一条时上限按条目算（200）——正文那 5000 的余量在一条里不存在
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
      // **不关**：地址不对是他还没打完，关掉等于清掉他打的字重来；理由也只写在这小块上（回执跑到正文底下就看不见）
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
        // 强调色只当底色与描边用，字一律走 ink：浅色档的 accent 压白字实测 3.2–4.2:1（AA 要 4.5）
        backgroundColor: dueUrgent ? `${theme.accent}26` : "rgba(0,0,0,0.06)",
        color: theme.ink,
        border: dueUrgent ? `1px solid ${theme.accent}` : "1px solid transparent",
      }}
    >
      {due.text}
    </span>
  ) : null;

  if (masked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Lock size={22} aria-hidden style={{ color: theme.accent }} />
        <button
          type="button"
          onClick={() =>
            void openUnlockWindow(id, "reveal").catch((error: unknown) =>
              logger.caught(SCOPE, "开口令窗失败", error),
            )
          }
          className="rounded-md border px-4 py-1.5 text-xs font-medium transition-opacity hover:opacity-80"
          style={{ borderColor: theme.accent, color: theme.ink }}
        >
          输入密码
        </button>
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            aria-label="删除便签"
            title="删除便签"
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
      /* 滚动条跟着这张纸的颜色走：两个变量写在根上、本屏所有滚容器共用（读它们的是 index.css 的 ::-webkit-scrollbar）；只写这一处是因"这张纸什么色"只有 themeColors 一个来源 */
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
        maxLength={TITLE_MAX}
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
          {/* 正文两态（阅读/编辑）。拖图两态都收：外面这层壳就是为这个存在——只挂 textarea 上的话看着图想拖进来反而拖不进 */}
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
                    // 剪贴板里有图就按图办：不拦的话浏览器粘进来的是文件名或本机路径，看着像成功其实什么图都没有
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
          有改动还没写进磁盘：会自己退避重试；这张还没揭开的那一笔，揭开后自动补做
        </div>
      )}

      {/* 页脚分两行：上=这张纸的元信息（归组槽/标签/字数，标签可能好几个，**允许换行**）；
          下=窗级动作那一排按钮，**单独一行不换行**。
          不换行不等于塞得下——窄窗真溢出就是"最后一枚按钮按不到"，这一行宽度在预览台按 220/318/520 三档量过。 */}
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
            maxLength={TAG_MAX}
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
          {/* 加图。走 webview 自己的文件框，不需要 fs/dialog 插件：拿到的就是 File 对象，字节随后由 media_save 落库 */}
          <button
            type="button"
            aria-label="加一张图"
            title="加一张图"
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
              if (row !== null) void attachToRow(row, files);
              else void attachToBody(files);
            }}
          />
          <button
            type="button"
            aria-label={autoLabel}
            title={autoLabel}
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
          <IconPicker id={id} note={note} />
          {/* 历史版本常驻入口（右键那条也在）。不分私密：私密版本住封套、锁着读不到，面板自己会说 */}
          <button
            type="button"
            aria-label="历史版本"
            title="历史版本"
            onClick={() => setHistoryOpen(true)}
            className="rounded p-1 transition-colors hover:bg-black/10"
            style={{ color: theme.accent }}
          >
            <History size={14} aria-hidden />
          </button>
          {/* 收回与密级是两件事，所以是两颗钮：这颗只管"把揭开的那几张蒙回"，
              旁边那颗只管翻这张的密级。设过口令才有得收回，没设过就不给这颗钮 */}
          {note.private && priv.active && (
            <>
              {lockConfirm && (
                <span className="text-[11px]" style={{ color: theme.ink }}>
                  立即锁定？
                </span>
              )}
              <button
                type="button"
                aria-label="立即锁定"
                title={lockConfirm ? "确认锁定" : "立即锁定"}
                onClick={() => {
                  if (lockConfirmTimer.current !== null)
                    clearTimeout(lockConfirmTimer.current);
                  setLockConfirm(false);
                  void lockNow();
                }}
                className="rounded p-1 transition-colors hover:bg-black/10"
                style={
                  lockConfirm
                    ? {
                        color: theme.ink,
                        backgroundColor: theme.accent,
                        borderRadius: "99px",
                      }
                    : { color: theme.accent }
                }
              >
                <EyeOff size={14} aria-hidden />
              </button>
            </>
          )}
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
            title="删除便签"
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

      {historyOpen && (
        <HistoryPanel
          noteId={id}
          ink={theme.ink}
          accent={theme.accent}
          onClose={() => setHistoryOpen(false)}
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
