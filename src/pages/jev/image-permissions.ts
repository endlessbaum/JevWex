import { captureTab } from "../../extension/capture";
import type { ContentScope } from "../../extension/content-scope";
import { imageOrigins } from "../../extension/page-images";
import {
  matchesUrl,
  type SiteRule,
  type UrlScope,
} from "../../extension/site-rules";

// Resolve exact hosts before the click so request stays in the user gesture.
export class ImagePermissions {
  private host = document.createElement("div");
  private note = document.createElement("p");
  private button = document.createElement("button");
  private generation = 0;
  private origins: string[] = [];
  constructor(anchor: HTMLElement) {
    this.host.hidden = true;
    this.note.className = "muted";
    this.button.type = "button";
    this.button.textContent = "画像の取得元を許可";
    this.button.hidden = true;
    this.host.append(this.note, this.button);
    anchor.after(this.host);
    this.button.onclick = () => {
      const origins = [...this.origins],
        generation = this.generation;
      if (!origins.length) return;
      const request = chrome.permissions.request({ origins });
      this.button.disabled = true;
      void request
        .then((granted) => {
          if (generation !== this.generation) return;
          this.note.textContent = granted
            ? "画像の取得元を許可しました。ショートカットからも画像を判定できます。"
            : "画像の取得には、表示した取得元の許可が必要です。";
          this.button.hidden = granted;
        })
        .catch((error) => {
          if (generation === this.generation)
            this.note.textContent = (error as Error).message;
        })
        .finally(() => {
          if (generation === this.generation) this.button.disabled = false;
        });
    };
  }
  async update(scope: ContentScope, url: string, urlScope: UrlScope = "exact") {
    const generation = ++this.generation;
    this.origins = [];
    this.host.hidden = !scope.images;
    this.button.hidden = true;
    this.button.disabled = false;
    if (!scope.images) return;
    this.note.textContent = "画像の取得元を確認しています…";
    try {
      const tabs = (await chrome.tabs.query({})).filter(
        (tab) =>
          tab.url &&
          matchesUrl(
            { url, scope: urlScope, enabled: true } as SiteRule,
            tab.url,
          ),
      );
      const tab = tabs.find((tab) => tab.active) ?? tabs[0];
      if (tab?.id === undefined)
        throw new Error(
          "画像の取得元を確認するには対象URLのページを開いて、対象を調整してください。",
        );
      const capture = await captureTab(tab.id, scope);
      const images = capture.items
        ? capture.items.flatMap((item) => item.images ?? [])
        : (capture.images ?? []);
      const origins = imageOrigins(images);
      const missing: string[] = [];
      for (const origin of origins)
        if (!(await chrome.permissions.contains({ origins: [origin] })))
          missing.push(origin);
      if (generation !== this.generation) return;
      this.origins = missing;
      this.note.textContent =
        `${images.length}枚の画像が対象です。` +
        (missing.length
          ? `画像を取得するため、次の配信元の読み取り許可が必要です：${missing.join("、")}`
          : "画像の取得元は許可済みです（埋め込み画像は許可不要）。");
      this.button.hidden = !missing.length;
    } catch (error) {
      if (generation === this.generation)
        this.note.textContent = (error as Error).message;
    }
  }
}
