import { describe, expect, it } from "vitest";
import { menuFor } from "@/features/sticky/note-menu";
import type { MenuHit, NoteState } from "@/features/sticky/note-menu";

const single: NoteState = {
  isPrivate: false,
  collapsed: false,
  canCollapse: true,
  canDeleteImage: true,
  bodyLabel: "复制正文",
};

const ids = (hit: MenuHit, note = single) => menuFor(hit, note).map((a) => a.id);
const labels = (hit: MenuHit, note = single) => menuFor(hit, note).map((a) => a.label);

describe("menuFor 通用尾巴", () => {
  it("空白处右键 = 就那五项，删除便签在最后", () => {
    expect(ids({ kind: "note" })).toEqual([
      "add-image",
      "copy-body",
      "toggle-private",
      "toggle-collapse",
      "delete-note",
    ]);
  });

  it("叠窗没有收起这一档", () => {
    expect(ids({ kind: "note" }, { ...single, canCollapse: false })).toEqual([
      "add-image",
      "copy-body",
      "toggle-private",
      "delete-note",
    ]);
  });

  it("私密标记跟着当前状态说反话", () => {
    expect(labels({ kind: "note" }, { ...single, isPrivate: true })).toContain(
      "取消私密",
    );
    expect(labels({ kind: "note" }, { ...single, collapsed: true })).toContain(
      "展开回正文",
    );
  });

  it("删除便签是唯一标红的项，且排最后", () => {
    const actions = menuFor({ kind: "note" }, single);
    const dangerous = actions.filter((a) => a.danger);
    expect(dangerous.map((a) => a.id)).toEqual(["delete-note"]);
    expect(actions.at(-1)?.id).toBe("delete-note");
  });
});

describe("menuFor 随对象变", () => {
  it("选中的字（对不上正文区间）：只给复制选中，不给变成链接", () => {
    expect(ids({ kind: "text", selected: "三个字", range: null })).toEqual([
      "copy-selection",
      "separator",
      "add-image",
      "copy-body",
      "toggle-private",
      "toggle-collapse",
      "delete-note",
    ]);
  });

  it("选中的字（落在正文里）：复制选中之后加一条变成链接，通用项还是那一串", () => {
    expect(
      ids({ kind: "text", selected: "三个字", range: { start: 4, end: 7 } }),
    ).toEqual([
      "copy-selection",
      "add-link",
      "separator",
      "add-image",
      "copy-body",
      "toggle-private",
      "toggle-collapse",
      "delete-note",
    ]);
  });

  it("只选了空白 = 等于没选，按空白处处理（不给一条按了没反应的复制）", () => {
    expect(ids({ kind: "text", selected: "  \n ", range: { start: 0, end: 3 } })).toEqual(
      ids({ kind: "note" }),
    );
  });

  it("编辑态选中：变成链接打头，加剪切与全选，尾巴还是那一串通用", () => {
    expect(
      ids({ kind: "editor", selected: "三个字", range: { start: 2, end: 5 } }),
    ).toEqual([
      "add-link",
      "copy-selection",
      "cut-selection",
      "select-all",
      "separator",
      "add-image",
      "copy-body",
      "toggle-private",
      "toggle-collapse",
      "delete-note",
    ]);
  });

  it("编辑态没有粘贴这一项（clipboard-read 在 WebView2 上不稳，作者拍板不引插件）", () => {
    const all = menuFor(
      { kind: "editor", selected: "字", range: { start: 0, end: 1 } },
      single,
    ).map((a) => a.id);
    expect(all).not.toContain("paste");
    // 空白处右键根本不接管（走系统菜单），所以这里至少还剩一个全选
    expect(ids({ kind: "editor", selected: "", range: { start: 3, end: 3 } })).toEqual([
      "select-all",
      "separator",
      "add-image",
      "copy-body",
      "toggle-private",
      "toggle-collapse",
      "delete-note",
    ]);
  });

  it("链接：打开 + 复制地址", () => {
    expect(ids({ kind: "link", href: "https://a.b" }).slice(0, 3)).toEqual([
      "open-link",
      "copy-link",
      "separator",
    ]);
  });

  it("远程图芯片：说的是「在浏览器里打开」，不是「打开链接」", () => {
    expect(
      labels({ kind: "remoteImage", href: "https://a.b/x.png" }).slice(0, 2),
    ).toEqual(["在浏览器里打开", "复制图片地址"]);
  });

  it("正文里的本机图：复制图片 + 删掉这张图（红、排在本段最后）", () => {
    expect(
      ids({ kind: "image", mediaId: "m0123456789ab", row: null }).slice(0, 3),
    ).toEqual(["copy-image", "delete-image", "separator"]);
  });

  it("引用不在手里这段文本里就不给「删掉这张图」（摘不到地方，删了就是孤儿字节）", () => {
    const got = ids(
      { kind: "image", mediaId: "m0123456789ab", row: { kind: "todo", id: "i1" } },
      { ...single, canDeleteImage: false },
    );
    expect(got).not.toContain("delete-image");
    expect(got.slice(0, 2)).toEqual(["copy-image", "separator"]);
  });

  it("清单/时间轴那一条里的选中：变成链接 + 复制选中，尾巴还是那一串通用", () => {
    expect(
      ids({
        kind: "row",
        row: { kind: "todo", id: "i1" },
        selected: "买菜",
        range: { start: 0, end: 2 },
      }),
    ).toEqual([
      "add-link",
      "copy-selection",
      "separator",
      "add-image",
      "copy-body",
      "toggle-private",
      "toggle-collapse",
      "delete-note",
    ]);
  });

  it("尾巴那一句跟着类型走：清单上说「复制清单」，不说一句假的「复制正文」", () => {
    expect(labels({ kind: "note" }, { ...single, bodyLabel: "复制清单" })[1]).toBe(
      "复制清单",
    );
    expect(labels({ kind: "note" }, { ...single, bodyLabel: "复制时间轴" })[1]).toBe(
      "复制时间轴",
    );
  });

  it("选中的是空白 = 那条上没有可操作的区间，按空白处处理", () => {
    expect(
      ids({
        kind: "row",
        row: { kind: "timeline", id: "t1" },
        selected: "  ",
        range: { start: 0, end: 2 },
      }),
    ).toEqual(ids({ kind: "note" }));
  });
});
