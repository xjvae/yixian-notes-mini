// 贴图那一步的**顺序**是加密的一部分，钉在这儿。
//
// `media_save` 的密级以**库行上**那个 `private` 为准（副本会晚半拍，反过来会把私密
// 便签的图写明文）。而"勾完私密立刻贴图"这一发，行上还停在旧值——那一次改动正躺在
// 250 毫秒的去抖队列里。所以 `attach` 必须先 `flushNow()` 再存字节：顺序一颠倒，
// 刚被保护起来的这张便签就摊开一张明文图。
//
// 这条在预览台验不出形状（假体不做密码学，看不出 enc 位），所以钉成单测。

// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { DbChangedEvent, StickyInput, StickyNote } from "@/platform/contracts";
import { createDefaultSticky } from "@/data/entities";
import type { NotesBackend } from "@/store/backend";
import {
  hydrateStore,
  initStore,
  resetStoreForTests,
  updateNote,
} from "@/store/notes-store";

/** 谁先谁后全记在这一串里：这是本用例唯一的判据 */
const order: string[] = [];

const bridge = vi.hoisted(() => ({
  currentWindowLabel: () => "self-window",
  listen: (_event: string, _handler: (payload: DbChangedEvent) => void) =>
    Promise.resolve(() => {}),
}));
vi.mock("@/platform/bridge", () => ({
  currentWindowLabel: bridge.currentWindowLabel,
  listen: bridge.listen,
}));

vi.mock("@/platform/commands", () => ({
  mediaSave: vi.fn((input: { noteId: string; private: boolean }) => {
    order.push(`mediaSave(private=${input.private})`);
    return Promise.resolve({
      id: "m1",
      noteId: input.noteId,
      mime: "image/png",
      width: 10,
      height: 10,
      enc: input.private,
    });
  }),
  mediaGet: vi.fn(() => Promise.resolve(null)),
  mediaDelete: vi.fn(() => Promise.resolve(true)),
}));

// 真机上这一步要 canvas（jsdom 没有），它在这里不是被验的对象
vi.mock("@/data/image-input", () => ({
  isAcceptedMime: (mime: string) => mime === "image/png",
  prepareImage: () => {
    order.push("prepareImage");
    return Promise.resolve({
      mime: "image/png",
      dataBase64: "AA==",
      width: 10,
      height: 10,
    });
  },
}));

import { useNoteImageAttacher } from "@/features/sticky/use-note-image";
import { mediaSave } from "@/platform/commands";

function note(id: string, overrides: Partial<StickyNote> = {}): StickyNote {
  return { ...createDefaultSticky(id, 1_700_000_000_000), ...overrides };
}

class MemoryBackend implements NotesBackend {
  rows = new Map<string, StickyNote>();

  bootstrap(): Promise<StickyNote[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  list(): Promise<StickyNote[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  upsert(input: StickyInput): Promise<StickyNote> {
    // 这一发就是"私密标记落到库行上"那一次写：库行从此与前端那份一致
    order.push(`upsert(private=${input.private})`);
    const saved = { ...input, deletedAt: null, createdAt: 1, updatedAt: 2 };
    this.rows.set(input.id, saved);
    return Promise.resolve(saved);
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
}

let backend: MemoryBackend;

beforeEach(async () => {
  order.length = 0;
  backend = new MemoryBackend();
  backend.rows.set("a", note("a", { title: "甲", private: false }));
  initStore(backend);
  await hydrateStore();
  vi.mocked(mediaSave).mockClear();
});

afterEach(() => {
  resetStoreForTests();
});

function png(name = "截图.png"): File {
  return new File([new Uint8Array([1])], name, { type: "image/png" });
}

describe("贴图前先让密级落库", () => {
  it("刚勾成私密就贴图：库行先变成私密，再存字节", async () => {
    const { result } = renderHook(() => useNoteImageAttacher("a"));
    // 勾私密那一次：只进内存与去抖队列，库行此刻还是 private=false
    updateNote("a", { private: true });
    order.length = 0;

    let refs: string[] = [];
    await act(async () => {
      refs = (await result.current.attach([png()], { room: 200, isPrivate: true })).refs;
    });

    expect(refs).toEqual(["![截图](media://m1)"]);
    expect(order, "顺序颠倒就是明文图").toEqual([
      "upsert(private=true)",
      "prepareImage",
      "mediaSave(private=true)",
    ]);
  });

  it("公开便签贴图：在途队列是空的，不该多出一次等待", async () => {
    const { result } = renderHook(() => useNoteImageAttacher("a"));
    let refs: string[] = [];
    await act(async () => {
      refs = (await result.current.attach([png()], { room: 200, isPrivate: false })).refs;
    });
    expect(refs).toEqual(["![截图](media://m1)"]);
    expect(order).toEqual(["prepareImage", "mediaSave(private=false)"]);
  });
});
