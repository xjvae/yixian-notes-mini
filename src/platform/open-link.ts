// 打开外部链接 — 全项目唯一的出口。
//
// 为什么不用 `<a target="_blank">`：webview 里开新窗被 Tauri 默认拦掉，点了就是没反应。
// 要真开系统浏览器就得走 opener 插件；capabilities 里只给了 `opener:allow-open-url`，
// 没给"在文件管理器里显示"那两条（本应用用不上，少一条权限就少一处能被打的地方）。
//
// 协议白名单在 data/body-parse.ts 的 safeHref 上（只放 http/https 进链接段），
// 这里**再挡一次**：这一层的入参来自"任何调用方都可能传进来的 url"，
// 只信渲染层那条正则等于没有守卫。

import { inDevPreview } from "@/platform/bridge";

/** http/https 且解析得动才算安全。`javascript:` / `data:` / 相对协议一律否 */
export function isSafeExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}

export async function openExternal(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) {
    throw new Error(`只开 http/https 链接，这个是 ${JSON.stringify(url)}`);
  }
  if (inDevPreview()) {
    // 预览台里没有系统浏览器可开。这条分支的意义是"识别出来的链接在预览台里也点得动"，
    // 不是假装开了浏览器——弹窗被不被拦由浏览器说了算
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
