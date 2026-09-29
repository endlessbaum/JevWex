import { CriteriaEditor, type CriterionDraft } from "./criteria-editor";
import {
  deleteRule,
  readRules,
  saveRule,
  scopeNames,
  matchesUrl,
  type SiteRule,
  type UrlScope,
} from "../../extension/site-rules";
import {
  describeScope,
  validateScope,
  type ContentScope,
} from "../../extension/content-scope";
import { openScopeEditor } from "../../extension/capture";
import { ImagePermissions } from "./image-permissions";

export class SitePage {
  private host = document.createElement("div");
  private editor: CriteriaEditor;
  private id = "";
  private rules: SiteRule[] = [];
  private dirty = false;
  private saving = false;
  private contentScope: ContentScope = { root: null, exclude: [] };
  private draftKey = "";
  private expected?: SiteRule;
  private imagePermissions: ImagePermissions;
  constructor(private getCriteria: () => CriterionDraft[]) {
    this.host.id = "sites-page";
    this.host.hidden = true;
    this.host.innerHTML = `
      <header><div><p class="eyebrow">Webページごとの設定</p><h1 tabindex="-1">URL別の判定条件</h1>
      <p class="lead">判定する対象と基準をセットで保存し、ページの判定で呼び出せます。</p></div></header>
      <p class="muted">「このURLのみ」はクエリまで一致（#以降は無視）。「配下のページ」は指定パスとその下、「サイト全体」は同じプロトコル・ホスト・ポートが対象です。</p>
      <div class="row"><label class="grow">条件を検索<input id="site-search" type="search" placeholder="条件名・URL"></label><button id="site-new" class="primary">新しい条件</button></div>
      <p id="site-status" role="status" aria-live="polite"></p>
      <div id="site-list"></div>
      <section id="site-form" hidden aria-labelledby="site-form-title">
        <h2 id="site-form-title">条件を編集</h2>
        <fieldset id="site-fields">
          <label>条件名<input id="site-name" maxlength="120" placeholder="例：技術記事の確認"></label>
          <label>対象URL<input id="site-url" type="url" maxlength="4096" placeholder="https://example.com/articles/"></label>
          <label>適用範囲<select id="site-scope"><option value="exact">このURLのみ</option><option value="subtree">配下のページ</option><option value="origin">サイト全体</option></select></label>
          <label class="site-check"><input id="site-enabled" type="checkbox" checked>この条件を有効にする</label>
          <h3>判定対象</h3><p id="site-target" class="muted"></p>
          <button id="site-target-edit" class="secondary">対象を調整する</button>
          <h3>判定基準</h3><div id="site-criteria"></div>
          <button id="site-add" class="secondary">＋ 判定基準を追加</button>
          <button id="site-copy" class="secondary">判定ページの基準をコピー</button>
          <div class="run-bar"><button id="site-save" class="primary">対象と基準を保存</button><button id="site-close" class="secondary">編集を閉じる</button></div>
        </fieldset>
        <p id="site-error" role="alert" hidden></p>
      </section>`;
    document.querySelector("main")!.prepend(this.host);
    this.imagePermissions = new ImagePermissions(this.el("site-target-edit"));
    const nav = document.createElement("a");
    nav.id = "nav-sites";
    nav.href = "#sites";
    nav.textContent = "URL別の判定条件";
    document.querySelector("nav")!.append(nav);
    this.editor = new CriteriaEditor(this.el("site-criteria"), () =>
      this.changed(),
    );
    this.el("site-fields").addEventListener("input", () => this.changed());
    this.el("site-search").oninput = () => this.renderList();
    this.el("site-new").onclick = () => this.open();
    this.el("site-add").onclick = () => {
      if (this.editor.read().length < 16) {
        this.editor.add();
        this.changed();
      }
    };
    this.el("site-copy").onclick = () => {
      if (confirm("編集中の基準を、判定ページの基準で置き換えますか？")) {
        this.setCriteria(this.getCriteria());
        this.changed();
      }
    };
    this.el("site-close").onclick = () => {
      if (this.canDiscard()) {
        this.el("site-form").hidden = true;
        this.dirty = false;
        if (this.draftKey) void chrome.storage.session.remove(this.draftKey);
        this.draftKey = "";
      }
    };
    this.el("site-save").onclick = () => void this.save();
    this.el("site-target-edit").onclick = () => void this.editTarget();
    window.addEventListener("beforeunload", (e) => {
      if (this.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
    window.addEventListener("pagehide", () => {
      if (this.draftKey) void chrome.storage.session.remove(this.draftKey);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") void this.refresh();
      const draft =
        area === "session" && this.draftKey
          ? changes[this.draftKey]?.newValue
          : undefined;
      if (draft?.applied && !this.el("site-form").hidden) {
        this.contentScope = validateScope(draft.scope);
        this.el("site-target").textContent = describeScope(this.contentScope);
        void this.imagePermissions.update(this.contentScope, draft.url);
        this.changed();
      }
    });
    void this.refresh();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) {
    return this.host.querySelector<T>(`#${id}`)!;
  }
  private changed() {
    this.dirty = true;
    this.el<HTMLButtonElement>("site-add").disabled =
      this.editor.read().length >= 16;
  }
  private canDiscard() {
    return (
      !this.saving && (!this.dirty || confirm("未保存の変更を破棄しますか？"))
    );
  }
  private setCriteria(criteria: CriterionDraft[]) {
    this.el("site-criteria").replaceChildren();
    for (const draft of criteria) this.editor.add(structuredClone(draft));
    this.el<HTMLButtonElement>("site-add").disabled = criteria.length >= 16;
  }
  open(rule?: SiteRule) {
    if (!this.canDiscard()) return;
    this.id = rule?.id ?? crypto.randomUUID();
    if (this.draftKey) void chrome.storage.session.remove(this.draftKey);
    this.draftKey = `jev-scope-draft:${crypto.randomUUID()}`;
    this.contentScope = structuredClone(
      rule?.contentScope ?? { root: null, exclude: [] },
    );
    this.expected =
      rule && this.rules.some((saved) => saved.id === rule.id)
        ? structuredClone(rule)
        : undefined;
    this.el("site-target").textContent = describeScope(this.contentScope);
    this.el<HTMLInputElement>("site-name").value = rule?.name ?? "";
    this.el<HTMLInputElement>("site-url").value = rule?.url ?? "";
    this.el<HTMLSelectElement>("site-scope").value = rule?.scope ?? "exact";
    this.el<HTMLInputElement>("site-enabled").checked = rule?.enabled ?? true;
    void this.imagePermissions.update(
      this.contentScope,
      rule?.url ?? "",
      rule?.scope,
    );
    this.setCriteria(rule?.criteria ?? []);
    if (!rule) this.editor.add();
    this.dirty = !!rule && !this.rules.some((saved) => saved.id === rule.id);
    this.el("site-form").hidden = false;
    this.el("site-error").hidden = true;
    location.hash = "sites";
    this.el("site-name").focus();
  }
  async refresh() {
    try {
      this.rules = await readRules();
      this.renderList();
    } catch (e) {
      this.el("site-status").textContent =
        `保存条件を読み込めませんでした：${(e as Error).message}`;
    }
  }
  private renderList() {
    const query = this.el<HTMLInputElement>("site-search").value.toLowerCase();
    const rules = this.rules.filter((r) =>
      `${r.name} ${r.url}`.toLowerCase().includes(query),
    );
    const list = this.el("site-list");
    list.replaceChildren();
    this.el("site-status").textContent =
      `${this.rules.length}件保存済み / ${rules.length}件表示`;
    if (!rules.length) {
      const p = document.createElement("p");
      p.textContent = "条件がありません。「新しい条件」から追加できます。";
      list.append(p);
    }
    for (const rule of rules) {
      const row = document.createElement("section");
      row.className = "site-rule";
      const title = document.createElement("h2");
      title.textContent = rule.name;
      const detail = document.createElement("p");
      detail.textContent = `${rule.enabled ? "有効" : "無効"} · ${scopeNames[rule.scope]} · ${rule.criteria.length}基準`;
      const url = document.createElement("p");
      url.className = "site-url";
      url.textContent = rule.url;
      const target = document.createElement("p");
      target.className = "muted";
      target.textContent = `対象：${describeScope(rule.contentScope)}`;
      const edit = document.createElement("button");
      edit.textContent = "編集";
      edit.className = "secondary";
      edit.onclick = () => this.open(rule);
      const remove = document.createElement("button");
      remove.textContent = "削除";
      remove.className = "secondary danger";
      remove.onclick = () =>
        void (async () => {
          if (this.saving || !confirm(`「${rule.name}」を削除しますか？`))
            return;
          try {
            await deleteRule(rule.id);
            if (this.id === rule.id) {
              this.el("site-form").hidden = true;
              this.dirty = false;
            }
            await this.refresh();
          } catch (e) {
            this.el("site-status").textContent =
              `削除できませんでした：${(e as Error).message}`;
          }
        })();
      const actions = document.createElement("div");
      actions.className = "row";
      actions.append(edit, remove);
      row.append(title, detail, url, target, actions);
      list.append(row);
    }
  }
  private async editTarget() {
    this.el("site-error").hidden = true;
    try {
      const rule = {
        url: this.el<HTMLInputElement>("site-url").value,
        scope: this.el<HTMLSelectElement>("site-scope").value as UrlScope,
        enabled: true,
      } as SiteRule;
      const tabs = (await chrome.tabs.query({})).filter(
        (tab) => tab.url && matchesUrl(rule, tab.url),
      );
      const tab = tabs.find((tab) => tab.active) ?? tabs[0];
      if (tab?.id === undefined)
        throw new Error(
          "対象URLのWebページを開いてから、もう一度「対象を調整する」を押してください。",
        );
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await openScopeEditor(tab.id, {
        scope: this.contentScope,
        key: this.draftKey,
      });
    } catch (error) {
      this.el("site-error").hidden = false;
      this.el("site-error").textContent = (error as Error).message;
    }
  }
  private async save() {
    if (this.saving) return;
    this.saving = true;
    this.el<HTMLFieldSetElement>("site-fields").disabled = true;
    this.el("site-error").hidden = true;
    try {
      const applied = this.draftKey
        ? (await chrome.storage.session.get(this.draftKey))[this.draftKey]
        : undefined;
      if (applied?.applied) this.contentScope = validateScope(applied.scope);
      const saved = await saveRule(
        {
          id: this.id,
          name: this.el<HTMLInputElement>("site-name").value,
          url: this.el<HTMLInputElement>("site-url").value,
          scope: this.el<HTMLSelectElement>("site-scope").value as UrlScope,
          enabled: this.el<HTMLInputElement>("site-enabled").checked,
          criteria: this.editor.read(),
          contentScope: this.contentScope,
        },
        this.expected,
      );
      this.expected = structuredClone(saved);
      this.el<HTMLInputElement>("site-url").value = saved.url;
      this.dirty = false;
      await this.refresh();
      this.el("site-status").textContent = `「${saved.name}」を保存しました。`;
    } catch (e) {
      this.el("site-error").hidden = false;
      this.el("site-error").textContent = (e as Error).message;
    } finally {
      this.saving = false;
      this.el<HTMLFieldSetElement>("site-fields").disabled = false;
    }
  }
}
