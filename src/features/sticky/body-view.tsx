// BodyView — 正文的**阅读态**外壳：一个能滚、能点进编辑态的框，里面画的是 RichText。
//
// 画法不在这里（在 rich-text.tsx，清单与时间轴条目共用那一份）；这里只管两件事：
//  · 这一格是 `flex-1` + `overflow-y-auto`：内容超出就自己滚，不撑破窗；
//  · 点任意处 / 敲任意键进编辑态（编辑态是 note-content 里那个 textarea）。
//
// 空正文也要有个可点的地方：不然"点这里开始写"这件事没处说，图片粘哪儿也不明显。

import { RichText } from "@/features/sticky/rich-text";

interface BodyViewProps {
  body: string;
  ink: string;
  accent: string;
  /** 点正文任意处进编辑态 */
  onEdit: () => void;
  /** 删掉本机图库里的那一张（连带正文里那句引用），由宿主决定确认与写回 */
  onDeleteImage?: (id: string) => void;
}

export function BodyView({ body, ink, accent, onEdit, onDeleteImage }: BodyViewProps) {
  if (body === "") {
    return (
      <button
        type="button"
        onClick={onEdit}
        data-body-slot=""
        aria-label="写点什么…（点这里开始，图片可以粘贴或拖进来）"
        className="min-h-0 w-full flex-1 cursor-text bg-transparent text-left text-[13px] italic opacity-45"
        style={{ color: ink }}
      >
        写点什么…（点这里开始，图片可以粘贴或拖进来）
      </button>
    );
  }

  /**
   * 点一下进编辑态，**但拖出来的选择不能被这一下抹掉**。
   * Chromium 里"按下与抬起在同一个元素上"就派发 click，拖选也算——以前这一句无条件
   * `onEdit`，于是拖选 → 立刻换成 textarea → 选择没了 → 右键也就没了（真机报的
   * "选中文字后右键是原始菜单、加链接没实现"）。要拿选区做动作，先得让选区活着。
   *
   * 判据只用 `isCollapsed`，不用 `toString()`：后者在**文档没拿到焦点**时给空串
   * （预览台里连顶层文档都这样，本轮已经在选区那条路上踩过一次），那样这道保护
   * 在预览台里等于没有，改完也验不出来。
   */
  const onClick = (): void => {
    const selection = window.getSelection();
    if (selection !== null && selection.rangeCount > 0 && !selection.isCollapsed) return;
    onEdit();
  };

  return (
    <div
      onClick={onClick}
      onKeyDown={onEdit}
      role="presentation"
      data-body-slot=""
      // `select-text` 落在这一格而不是只落在文字上：窗体那层是 `select-none`，
      // 只有文字段自己翻回 `text` 的话，从行末空白或段间空隙按下左键就起不了选区
      className="min-h-0 w-full flex-1 cursor-text overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words text-[13px] leading-relaxed select-text"
      style={{ color: ink }}
    >
      {/* 里面这一层是"内容本体"：外面那格是 flex-1，窗多高它多高，量它的 scrollHeight
          永远量不到"内容变短了"（scrollHeight 不低于 clientHeight）。自动长高度的是这一层 */}
      <div data-body-content="">
        <RichText body={body} ink={ink} accent={accent} onDeleteImage={onDeleteImage} />
      </div>
    </div>
  );
}
