import {
  pageContent,
  readScope,
  type ContentScope,
  type PageTarget,
} from "./content-scope";
import type { PageImage } from "./page-images";
import type { PageLink } from "./page-links";

export interface PageCapture {
  target?: PageTarget;
  images?: PageImage[];
  links?: PageLink[];
  items?: {
    target?: PageTarget;
    index: number;
    selector: string;
    label: string;
    text: string;
    truncated: boolean;
    images?: PageImage[];
    links?: PageLink[];
  }[];
  tabId: number;
  documentId?: string;
  url: string;
  title: string;
  text: string;
  selection: string;
  truncated: boolean;
  selectionTruncated: boolean;
  capturedAt: string;
  contentScope?: {
    root: string;
    label: string;
    excluded: number;
    automatic: boolean;
    characters: number;
    originalCharacters: number;
  };
}
export interface CaptureNotice {
  id: string;
  capture?: PageCapture;
  error?: string;
}
export const captureKey = (windowId: number) => `jev-page-capture:${windowId}`;

export class CapturePermissionError extends Error {}

// Chrome host permissions cover a scheme and host, including all its ports.
export function pagePermissionOrigin(
  value: string | undefined,
): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.hostname === "chromewebstore.google.com" ||
      (url.hostname === "chrome.google.com" &&
        url.pathname.startsWith("/webstore"))
    )
      return;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return;
  }
}

function permissionFailure(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /permission|Cannot access contents|not allowed/i.test(detail);
}

export function captureError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/No tab with id|tab was closed/i.test(detail))
    return "対象のタブが閉じられました。判定したいページを開いてください。";
  if (
    /unsupported|chrome:\/\/|edge:\/\/|chrome-extension:\/\/|extensions gallery|web store/i.test(
      detail,
    )
  )
    return "このページは取得対象外です。通常のWebページで使用してください。ブラウザの設定画面・拡張の管理画面・ストアなどは読み取れません。";
  if (
    /permission|Cannot access contents|Cannot access a chrome|not allowed/i.test(
      detail,
    )
  )
    return "このタブの読み取り権限がありません。通常のWebページでは、ツールバーのJevWex拡張アイコンを押すか、パネルの「このサイトを許可して再取得」から許可してください。ブラウザの設定画面・拡張の管理画面などは取得対象外です。";
  return `ページを取得できませんでした。読み込み完了後に再取得してください。${detail ? `（${detail}）` : ""}`;
}

export async function captureTab(
  tabId: number,
  override?: ContentScope,
): Promise<PageCapture> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:\/\//.test(tab.url))
      throw new Error("unsupported");
    const scope = override ?? (await readScope(tab.url));
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageContent,
      args: [scope, false, tab.url],
    });
    const result = injection?.result;
    if (result && "error" in result) throw new Error(result.error);
    if (!result || !/^https?:\/\//.test(result.url))
      throw new Error("unsupported");
    return { ...result, tabId, documentId: injection.documentId };
  } catch (error) {
    const message = captureError(error);
    throw permissionFailure(error)
      ? new CapturePermissionError(message)
      : new Error(message);
  }
}

export async function openScopeEditor(
  tabId: number,
  draft?: { scope: ContentScope; key: string },
) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//.test(tab.url))
    throw new Error("通常のWebページを開いてください。");
  if (draft) {
    if (!draft.key.startsWith("jev-scope-draft:"))
      throw new Error("対象の編集情報が正しくありません。");
    await chrome.storage.session.set({
      [draft.key]: { tabId, url: tab.url, scope: draft.scope },
    });
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageContent,
    args: draft
      ? [draft.scope, true, tab.url, draft.key]
      : [await readScope(tab.url), true, tab.url],
  });
  if (injection?.result && "error" in injection.result)
    throw new Error(injection.result.error);
}
