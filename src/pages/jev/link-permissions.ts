import { captureTab } from "../../extension/capture";
import type { ContentScope } from "../../extension/content-scope";
import { linkOrigins } from "../../extension/page-links";
import {
  matchesUrl,
  type SiteRule,
  type UrlScope,
} from "../../extension/site-rules";

export class LinkPermissions {
  private host = document.createElement("div");
  private note = document.createElement("p");
  private button = document.createElement("button");
  private refresh = document.createElement("button");
  private preview = document.createElement("pre");
  private generation = 0;
  private origins: string[] = [];
  private target?: { tabId: number; url: string; scope: ContentScope };
  private requestId = "";
  constructor(anchor: HTMLElement) {
    this.host.hidden = true;
    this.host.dataset.linkPermissions = "";
    this.note.className = "muted";
    this.button.type = this.refresh.type = "button";
    this.button.textContent = "リンク先の取得を許可";
    this.refresh.textContent = "リンク先を取得して確認";
    this.preview.className = "link-excerpt-preview";
    this.preview.hidden = true;
    this.host.append(this.note, this.button, this.refresh, this.preview);
    anchor.after(this.host);
    this.refresh.onclick = () => void this.loadPreview();
    this.button.onclick = () => {
      const generation = this.generation;
      if (!this.origins.length) return;
      const permission = chrome.permissions.request({
        origins: [...this.origins],
      });
      this.button.disabled = true;
      void permission
        .then(async (granted) => {
          if (generation !== this.generation) return;
          if (!granted) {
            this.note.textContent =
              "リンク先の取得には、表示したサイトのアクセス許可が必要です。";
            return;
          }
          this.button.hidden = true;
          this.refresh.hidden = false;
          this.note.textContent =
            "リンク先の取得を許可しました。本文のプレビューは先頭4リンクです。";
          await this.loadPreview();
        })
        .catch((error) => {
          if (generation === this.generation)
            this.note.textContent = error.message;
        })
        .finally(() => {
          if (generation === this.generation) this.button.disabled = false;
        });
    };
  }
  private cancel() {
    if (this.requestId)
      void chrome.runtime
        .sendMessage({
          type: "jev-cancel-link-preview",
          requestId: this.requestId,
        })
        .catch(() => {});
    this.requestId = "";
  }
  private async loadPreview() {
    this.cancel();
    const target = this.target,
      generation = this.generation;
    if (!target) return;
    const requestId = (this.requestId = crypto.randomUUID());
    this.preview.hidden = false;
    this.preview.textContent = "リンク先の本文を取得しています…";
    this.refresh.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "jev-preview-link-scope",
        requestId,
        ...target,
      });
      if (generation !== this.generation || this.requestId !== requestId)
        return;
      this.preview.textContent =
        response?.error ?? response?.text ?? "取得できませんでした。";
    } catch (error) {
      if (generation === this.generation)
        this.preview.textContent = (error as Error).message;
    } finally {
      if (generation === this.generation) this.refresh.disabled = false;
    }
  }
  async update(scope: ContentScope, url: string, urlScope: UrlScope = "exact") {
    this.cancel();
    const generation = ++this.generation;
    this.origins = [];
    this.target = undefined;
    this.host.hidden = !scope.linkedPages;
    this.button.hidden = this.refresh.hidden = this.preview.hidden = true;
    this.button.disabled = this.refresh.disabled = false;
    if (!scope.linkedPages) return;
    this.note.textContent = "対象のリンク先を確認しています…";
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
          "リンク先を確認するには、対象URLのページを開いてください。",
        );
      const capture = await captureTab(tab.id, scope);
      const links = capture.items
        ? capture.items.flatMap((item) => item.links ?? [])
        : (capture.links ?? []);
      const missing: string[] = [];
      for (const origin of linkOrigins(links))
        if (!(await chrome.permissions.contains({ origins: [origin] })))
          missing.push(origin);
      if (generation !== this.generation) return;
      this.target = {
        tabId: tab.id,
        url: capture.url,
        scope: structuredClone(scope),
      };
      this.origins = missing;
      this.note.textContent = `${links.length}件のリンク先が対象です。contents配下、なければbody配下の本文を、モデルの入力上限の80%以下の文字数で判定します。${missing.length ? `取得に必要なサイトの許可：${missing.join("、")}` : "取得先は許可済みです。"}`;
      this.button.hidden = !missing.length;
      this.refresh.hidden = !!missing.length;
      if (links.length && !missing.length) await this.loadPreview();
    } catch (error) {
      if (generation === this.generation)
        this.note.textContent = (error as Error).message;
    }
  }
  dispose() {
    this.cancel();
    this.generation++;
  }
}
