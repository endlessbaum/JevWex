import type { PageCapture } from "./capture";

export interface PageLink {
  url: string;
  label: string;
}
export interface LinkExcerpt extends PageLink {
  title: string;
  text: string;
  truncated: boolean;
}
export const LINK_LIMITS = {
  perInput: 4,
  bytes: 1024 * 1024,
  timeoutMs: 15000,
} as const;
export function linkCharacterLimit(context?: number): number {
  // Until a manager advertises its capacity, previews use a conservative size.
  return Math.floor(
    (Number.isSafeInteger(context) && context! > 0
      ? Math.min(context!, 65536)
      : 1024) * 0.8,
  );
}
export function linkOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      value.length > 4000
    )
      return;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return;
  }
}
export function linkOrigins(links: readonly PageLink[]) {
  return [
    ...new Set(
      links.flatMap((link) => {
        const origin = linkOrigin(link.url);
        return origin ? [origin] : [];
      }),
    ),
  ];
}
export async function fetchLinkHtml(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
  allowed: (origin: string) => Promise<boolean> = (origin) =>
    chrome.permissions.contains({ origins: [origin] }),
): Promise<string> {
  const origin = linkOrigin(url);
  if (!origin)
    throw new Error("リンク先はHTTP(S)の通常のWebページを指定してください。");
  signal.throwIfAborted();
  if (!(await allowed(origin)))
    throw new Error(
      `リンク先 ${origin} が未許可です。条件画面の「リンク先の取得を許可」を押してください。`,
    );
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LINK_LIMITS.timeoutMs);
  try {
    // Do not navigate a tab or run the destination's scripts. Redirects must not
    // fetch a second host before its permission has been checked.
    const response = await fetcher(url, {
      method: "GET",
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        `リンク先の取得に失敗しました（HTTP ${response.status}）。`,
      );
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^text\/html(?:\s*;|$)/i.test(contentType))
      throw new Error(
        "リンク先はHTMLページではありません。PDFやダウンロードファイルは対象外です。",
      );
    if (Number(response.headers.get("content-length")) > LINK_LIMITS.bytes)
      throw new Error("リンク先のHTMLが1 MiBを超えています。");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("リンク先のHTMLを取得できませんでした。");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > LINK_LIMITS.bytes)
          throw new Error("リンク先のHTMLが1 MiBを超えています。");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    controller.signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const headerCharset = contentType.match(
      /charset\s*=\s*["']?([^\s;"']+)/i,
    )?.[1];
    const head = new TextDecoder().decode(bytes.slice(0, 4096));
    const metaCharset = head.match(
      /<meta\b[^>]*charset\s*=\s*["']?([^\s;"'/>]+)/i,
    )?.[1];
    try {
      return new TextDecoder(headerCharset ?? metaCharset ?? "utf-8").decode(
        bytes,
      );
    } catch {
      throw new Error("リンク先の文字コードに対応していません。");
    }
  } catch (error) {
    if (signal.aborted)
      throw signal.reason ?? new Error("リンク先の取得を中止しました。");
    if (timedOut)
      throw new Error("リンク先の取得が15秒以内に完了しませんでした。");
    if (error instanceof TypeError)
      throw new Error(
        "リンク先に接続できません。リダイレクト先の場合は最終URLを指定してください。",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

// Serialized into the source tab's isolated world. Template contents stay in
// an inert document: no remote scripts, styles, images or frames are loaded.
// Keep all helpers/constants inside this function, and never attach its nodes.
export function extractLinkExcerpt(html: string, characterLimit: number) {
  try {
    if (
      !Number.isSafeInteger(characterLimit) ||
      characterLimit < 1 ||
      characterLimit > 65536
    )
      return { error: "本文の文字数上限が正しくありません。" };
    const template = document.createElement("template");
    // Parsing in an HTML element preserves body/head wrappers; its owner is
    // the template's inert document, so remote resources remain inactive.
    const root = template.content.ownerDocument.createElement("html");
    root.innerHTML = html;
    template.content.append(root);
    const content = template.content;
    const title = (content.querySelector("title")?.textContent ?? "")
      .trim()
      .slice(0, 300);
    content
      .querySelectorAll(
        'script,style,noscript,template,iframe,object,embed,img,svg,head,nav,header,footer,form,input,textarea,select,button,[hidden],[aria-hidden="true"]',
      )
      .forEach((el) => el.remove());
    content.querySelectorAll("[style]").forEach((el) => {
      if (
        /display\s*:\s*none|visibility\s*:\s*(hidden|collapse)/i.test(
          el.getAttribute("style") ?? "",
        )
      )
        el.remove();
    });
    function read(node: Node, depth = 0): string {
      if (depth > 128) return "";
      if (node.nodeType === Node.TEXT_NODE)
        return node.textContent?.replace(/\s+/g, " ") ?? "";
      if (node instanceof Element && node.tagName === "BR") return "\n";
      const text = [...node.childNodes]
        .map((child) => read(child, depth + 1))
        .join("");
      return node instanceof Element &&
        /^(P|DIV|SECTION|ARTICLE|MAIN|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TR)$/.test(
          node.tagName,
        )
        ? `\n${text}\n`
        : text;
    }
    const body = content.querySelector("body");
    if (!body) return { error: "リンク先にbody要素がありません。" };
    const selected =
      body.querySelector("#contents") ??
      body.querySelector(".contents") ??
      body.querySelector("contents") ??
      body;
    const text = read(selected)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text)
      return {
        error:
          "リンク先のHTMLから本文を取得できません。ログインやJavaScript表示が必要なページは対応していません。",
      };
    return {
      title,
      text: text.slice(0, characterLimit),
      truncated: text.length > characterLimit,
    };
  } catch {
    return { error: "リンク先のHTMLを解析できませんでした。" };
  }
}
export async function loadLinkExcerpts(
  capture: PageCapture,
  links: readonly PageLink[],
  signal: AbortSignal,
  characterLimit: number,
): Promise<LinkExcerpt[]> {
  if (!links.length)
    throw new Error(
      "この対象に取得可能なリンクがありません。hrefのあるaタグを選んでください。",
    );
  const unique = [...new Map(links.map((link) => [link.url, link])).values()];
  if (unique.length > LINK_LIMITS.perInput)
    throw new Error(
      "1件の対象のリンクは4件までです。不要なリンクを除外するか、子要素を1件ずつ判定してください。",
    );
  const excerpts: LinkExcerpt[] = [];
  for (const link of unique) {
    const html = await fetchLinkHtml(link.url, signal);
    signal.throwIfAborted();
    const [injection] = await chrome.scripting.executeScript({
      target: capture.documentId
        ? { tabId: capture.tabId, documentIds: [capture.documentId] }
        : { tabId: capture.tabId },
      func: extractLinkExcerpt,
      args: [html, characterLimit],
    });
    signal.throwIfAborted();
    const result = injection?.result;
    if (!result || "error" in result)
      throw new Error(
        result?.error ??
          "リンク先の本文を確認できません。元のページで再取得してください。",
      );
    excerpts.push({ ...link, ...result });
  }
  return excerpts;
}
export function limitLinkExcerpts(
  excerpts: readonly LinkExcerpt[],
  characterLimit: number,
): LinkExcerpt[] {
  const headers = excerpts
    .map((_, i) => `【リンク先 ${i + 1}】\n本文（上限のため一部を省略）：\n`)
    .join("\n\n");
  let remaining = characterLimit - headers.length;
  if (remaining < excerpts.length)
    throw new Error(
      "モデルの入力上限にリンク先の本文が収まりません。リンクを1件ずつ判定してください。",
    );
  return excerpts.map((link, i) => {
    const budget = Math.floor(remaining / (excerpts.length - i));
    const text = link.text.slice(0, budget);
    remaining -= text.length;
    return {
      ...link,
      text,
      truncated: link.truncated || text.length < link.text.length,
    };
  });
}
export function linkInput(
  excerpts: readonly LinkExcerpt[],
  characterLimit: number,
) {
  return limitLinkExcerpts(excerpts, characterLimit)
    .map(
      (link, i) =>
        `【リンク先 ${i + 1}】\n本文${link.truncated ? "（上限のため一部を省略）" : ""}：\n${link.text}`,
    )
    .join("\n\n");
}

// Display only. Never pass this abbreviated text to inference.
export function linkPreviewText(link: LinkExcerpt) {
  const lines = link.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const beginning = lines
    .slice(0, 3)
    .map((line) => (line.length > 100 ? `${line.slice(0, 100)}…` : line))
    .join("\n");
  const omitted =
    lines.length > 3 || lines.slice(0, 3).some((line) => line.length > 100);
  return `取得成功：${link.label}\nURL：${link.url}\nページタイトル：${link.title}\n取得本文：${link.text.length.toLocaleString()}文字${link.truncated ? "（入力上限で一部省略）" : ""}\n${beginning}${omitted ? "\n…（続きはプレビューでは省略）" : ""}`;
}
