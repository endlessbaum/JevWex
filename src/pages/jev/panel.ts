import "./panel.css";
import {
  captureKey,
  captureTab,
  CapturePermissionError,
  pagePermissionOrigin,
  openScopeEditor,
  type CaptureNotice,
  type PageCapture,
} from "../../extension/capture";
import {
  matchingRules,
  readRules,
  saveRule,
  setRuleEnabled,
  scopeNames,
  type SiteRule,
  type UrlScope,
} from "../../extension/site-rules";
import {
  JUDGE_CHANNEL,
  type JudgeMessage,
  type ManagerStatus,
} from "../../extension/judge-channel";
import { CriteriaEditor } from "./criteria-editor";
import { ImagePermissions } from "./image-permissions";
import {
  describeScope,
  readScope,
  validateScope,
  type ContentScope,
} from "../../extension/content-scope";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const channel = new BroadcastChannel(JUDGE_CHANNEL);
const imagePermissions = new ImagePermissions($("create-target-edit"));
const managers = new Map<string, ManagerStatus & { seen: number }>();
let capture: PageCapture | undefined;
let rules: SiteRule[] = [];
let windowId: number | undefined;
let noticeId = "",
  fetchId = 0,
  rulesId = 0;
let job: { jobId: string; phase: string; message: string } | undefined;
let sourceTabId: number | undefined;
let permissionTarget: { tabId: number; origin: string } | undefined;
let starting = false,
  saving = false,
  dirty = false;
let draftScope: ContentScope = { root: null, exclude: [] };
let draftKey = "";
let draftPageUrl = "";
let editingRule: SiteRule | undefined;
let draftCaptureError = false;
const jobKey = (tabId: number) => `jev-page-job:${tabId}`;
function manager() {
  return [...managers.values()].sort(
    (a, b) => Number(b.ready) - Number(a.ready) || a.id.localeCompare(b.id),
  )[0];
}
function text() {
  return capture?.text ?? "";
}
function error(message: string) {
  $("error").textContent = message;
  $("error").hidden = !message;
}
function render() {
  const engine = manager();
  $("model-status").textContent = engine?.ready
    ? `準備完了：${engine.model}${engine.supportsImages ? "（画像対応）" : ""}`
    : engine
      ? `${engine.model || "モデル未選択"}：${engine.phase}`
      : "管理画面でモデルを読み込んでください。";
  $<HTMLButtonElement>("run").disabled =
    starting ||
    job?.phase === "running" ||
    !engine?.ready ||
    !capture ||
    !rules.some((rule) => rule.enabled);
  $<HTMLButtonElement>("cancel").disabled = job?.phase !== "running";
  $<HTMLButtonElement>("new-rule").disabled = !capture || saving;
  $("open-models").hidden = !!engine?.ready;
  $("run").textContent = "オンの条件で判定";
  $("target-preview").hidden = !$("create-condition").hidden;
}
function showText() {
  const batch = capture?.items;
  $("source-preview").textContent = batch
    ? batch
        .map(
          (item) =>
            `【${item.index}件目 · ${item.text.length.toLocaleString()}文字】\n${item.text}`,
        )
        .join("\n\n")
    : text();
  const scope = capture?.contentScope;
  $("scope-summary").textContent = scope
    ? `${scope.automatic ? "自動選択" : "保存済み"}：${scope.label} · ${scope.characters.toLocaleString()} / ${scope.originalCharacters.toLocaleString()}文字 · 除外 ${scope.excluded}件。文字数はトークン数とは異なります。`
    : "本文候補を自動で選びます。対象は判定条件の作成・編集画面で調整できます。";
  if (batch)
    $("scope-summary").textContent +=
      ` ${batch.length}件をそれぞれ独立して判定します。`;
  if (batch ? batch.some((item) => item.truncated) : capture?.truncated)
    $("scope-summary").textContent +=
      " 1件あたり先頭48,000文字まで取得しています。";
  if (draftCaptureError) {
    $("source-preview").textContent = "";
    $("scope-summary").textContent =
      "新しい条件の対象を取得できません。判定条件の作成画面で対象を選び直してください。保存済みの条件はそれぞれの対象を使います。";
  }
  render();
}
function renderRules() {
  const host = $("source-rules");
  host.replaceChildren();
  for (const rule of rules) {
    const label = document.createElement("label");
    label.className = "rule-toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = rule.enabled;
    box.setAttribute("role", "switch");
    box.setAttribute("aria-label", `${rule.name}をオンにする`);
    const detail = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = rule.name;
    const meta = document.createElement("small");
    meta.textContent = `${scopeNames[rule.scope]} · ${rule.criteria.length}基準 · ${rule.enabled ? "オン" : "オフ"}`;
    const target = document.createElement("small");
    target.textContent = `対象：${describeScope(rule.contentScope)}`;
    detail.append(name, meta, target);
    label.append(detail, box);
    const row = document.createElement("div");
    row.className = "saved-rule";
    const edit = document.createElement("button");
    edit.className = "link";
    edit.textContent = "対象・基準を編集";
    edit.onclick = () => void openRule(rule).catch((e) => error(e.message));
    row.append(label, edit);
    host.append(row);
    box.onchange = () =>
      void (async () => {
        box.disabled = true;
        try {
          await setRuleEnabled(rule.id, box.checked);
          await loadRules();
        } catch (e) {
          box.checked = rule.enabled;
          box.disabled = false;
          error((e as Error).message);
        }
      })();
  }
  $("rule-note").textContent = !capture
    ? "ページを取得すると、このURLの判定条件を表示します。"
    : rules.length
      ? `${rules.filter((rule) => rule.enabled).length} / ${rules.length}件がオン。それぞれに保存した対象と基準で判定します。`
      : "このURLの条件はまだありません。ここで新しく作成できます。";
  render();
}
async function loadRules() {
  const current = capture;
  if (!current) return;
  const id = ++rulesId;
  try {
    const next = matchingRules(await readRules(), current.url, true);
    if (id !== rulesId || capture !== current) return;
    rules = next;
    renderRules();
  } catch (e) {
    error(`条件を読み込めませんでした：${(e as Error).message}`);
  }
}
function updateJob(value: typeof job) {
  job = value;
  $("progress").textContent = value
    ? `${value.message}${value.phase === "complete" ? " 結果はページ上に表示しています。" : ""}`
    : "";
  render();
}
async function accept(value: PageCapture) {
  capture = value;
  sourceTabId = value.tabId;
  $("source-title").textContent = value.title;
  $("source-url").textContent = value.url;
  $("source-time").textContent =
    `${new Date(value.capturedAt).toLocaleTimeString()} に取得。本文が変わった場合は再取得してください。`;
  error(
    value.text ||
      value.images?.length ||
      value.items?.some((item) => item.images?.length)
      ? ""
      : "読み取れる文章がありません。画像を判定する場合は条件の対象編集で画像を含めてください。PDF・iframe内は対象外です。",
  );
  showText();
  const [data] = await Promise.all([
    chrome.storage.session.get(jobKey(value.tabId)),
    loadRules(),
  ]);
  if (capture === value) updateJob(data[jobKey(value.tabId)]);
}
async function receive(notice: CaptureNotice) {
  if (notice.id === noticeId) return;
  noticeId = notice.id;
  // The action's async capture can finish after the user has switched tabs.
  if (notice.capture) {
    const id = fetchId;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (id !== fetchId || tab?.id !== notice.capture.tabId) return;
    await refreshSource();
  } else {
    // Resolve the current tab again instead of applying an old action's error.
    await refreshSource();
  }
}
function clearSource(message: string) {
  draftCaptureError = false;
  permissionTarget = undefined;
  $("source-refresh").textContent = "現在のページを再取得";
  capture = undefined;
  rules = [];
  rulesId++;
  $("source-title").textContent = message;
  $("source-url").textContent = "";
  $("source-time").textContent = "";
  error("");
  updateJob(undefined);
  renderRules();
  showText();
}
async function refreshSource() {
  const id = ++fetchId;
  let target: chrome.tabs.Tab | undefined;
  clearSource("ページを取得しています…");
  $<HTMLButtonElement>("source-refresh").disabled = true;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      ...(windowId === undefined ? { currentWindow: true } : { windowId }),
    });
    if (id !== fetchId) return;
    sourceTabId = tab?.id;
    target = tab;
    if (tab?.id === undefined) throw new Error("対象のページがありません。");
    if (tab.url && !pagePermissionOrigin(tab.url))
      throw new Error(
        "このページは取得対象外です。通常のWebページを開いてください。",
      );
    const value = await captureTab(tab.id);
    if (id === fetchId) await accept(value);
  } catch (e) {
    if (id === fetchId) {
      clearSource("ページを取得できませんでした");
      const origin = pagePermissionOrigin(target?.url);
      if (
        e instanceof CapturePermissionError &&
        target?.id !== undefined &&
        origin
      ) {
        permissionTarget = { tabId: target.id, origin };
        $("source-refresh").textContent = "このサイトを許可して再取得";
        error(
          `${new URL(target.url!).hostname} の読み取り権限がありません。「このサイトを許可して再取得」を押し、Chromeの確認画面で許可してください。`,
        );
      } else {
        // A broken new-rule draft must not hide saved target/criteria pairs.
        if (target?.id !== undefined && origin) {
          try {
            const fallback = await captureTab(target.id, {
              root: null,
              exclude: [],
            });
            if (id === fetchId) {
              await accept(fallback);
              draftCaptureError = true;
              showText();
            }
          } catch {
            /* Keep the original capture error. */
          }
        }
        if (id === fetchId) error((e as Error).message);
      }
    }
  } finally {
    if (id === fetchId) {
      $<HTMLButtonElement>("source-refresh").disabled = false;
      render();
    }
  }
}
$("source-refresh").onclick = () => {
  const target = permissionTarget;
  if (!target) {
    void refreshSource();
    return;
  }
  // Request synchronously in the click handler, before any await loses the gesture.
  const request = chrome.permissions.request({ origins: [target.origin] });
  $<HTMLButtonElement>("source-refresh").disabled = true;
  error("Chromeの確認画面で、このサイトの読み取りを許可してください。");
  void (async () => {
    try {
      const granted = await request;
      // A tab change/navigation may already have started a different capture.
      if (permissionTarget !== target) return;
      if (granted) await refreshSource();
      else
        error(
          "読み取りが許可されなかったため取得していません。再度許可するか、対象ページでツールバーのJevWexアイコンを押してください。",
        );
    } catch (e) {
      if (permissionTarget === target)
        error(`読み取りの許可を取得できませんでした：${(e as Error).message}`);
    } finally {
      if (permissionTarget === target)
        $<HTMLButtonElement>("source-refresh").disabled = false;
    }
  })();
};
chrome.tabs.onActivated.addListener((info) => {
  if (info.windowId === windowId) void refreshSource();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== sourceTabId) return;
  if (change.status === "loading") {
    fetchId++;
    clearSource("ページの読み込みを待っています…");
    $<HTMLButtonElement>("source-refresh").disabled = false;
  } else if (change.status === "complete" || change.url) {
    void refreshSource();
  }
});
async function openManagement(destination: "models" | "sites") {
  const engine = manager();
  if (engine?.tabId !== undefined) {
    try {
      const tab = await chrome.tabs.update(engine.tabId, { active: true });
      if (tab) await chrome.windows.update(tab.windowId, { focused: true });
      channel.postMessage({
        type: "manage",
        managerId: engine.id,
        destination,
      } satisfies JudgeMessage);
      return;
    } catch {
      managers.delete(engine.id);
    }
  }
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`index.html#${destination}`),
  });
}
for (const [id, destination] of [
  ["open-management", "sites"],
  ["open-models", "models"],
  ["manage-rule", "sites"],
] as const)
  $(id).onclick = () =>
    void openManagement(destination).catch((e) => error((e as Error).message));

const editor = new CriteriaEditor($("create-criteria"), () => {
  dirty = true;
  $<HTMLButtonElement>("create-add").disabled = editor.read().length >= 16;
});
$("create-fields").addEventListener("input", () => {
  dirty = true;
});
async function openRule(rule?: SiteRule) {
  if (
    !capture ||
    saving ||
    (dirty && !confirm("未保存の条件を破棄して新しく作成しますか？"))
  )
    return;
  const page = capture;
  const scope = rule?.contentScope ?? (await readScope(page.url));
  if (capture !== page) return;
  if (draftKey) void chrome.storage.session.remove(draftKey);
  draftKey = `jev-scope-draft:${crypto.randomUUID()}`;
  draftScope = structuredClone(scope);
  draftPageUrl = page.url;
  editingRule = rule ? structuredClone(rule) : undefined;
  $("create-criteria").replaceChildren();
  if (rule)
    for (const criterion of rule.criteria)
      editor.add(structuredClone(criterion));
  else
    editor.add({
      id: crypto.randomUUID(),
      alias: "判定基準1",
      type: "noul",
      instructions: "",
      labels: [],
    });
  $<HTMLInputElement>("create-name").value = rule?.name ?? "";
  $<HTMLInputElement>("create-url").value = rule?.url ?? page.url;
  $<HTMLSelectElement>("create-scope").value = rule?.scope ?? "exact";
  $("create-title").textContent = rule
    ? "対象と判定基準を編集"
    : "対象と判定基準を保存";
  $("create-target").textContent = `対象：${describeScope(draftScope)}`;
  void imagePermissions.update(
    draftScope,
    rule?.url ?? draftPageUrl,
    rule?.scope,
  );
  $<HTMLButtonElement>("create-add").disabled = false;
  $("create-condition").hidden = false;
  $("create-error").hidden = true;
  dirty = false;
  $("create-name").focus();
  render();
}
$("new-rule").onclick = () => void openRule().catch((e) => error(e.message));
$("create-target-edit").onclick = () => {
  if (!capture || capture.url !== draftPageUrl) {
    $("create-error").hidden = false;
    $("create-error").textContent =
      "対象を調整するには、編集を始めたWebページに戻ってください。";
    return;
  }
  void openScopeEditor(capture.tabId, {
    scope: draftScope,
    key: draftKey,
  }).catch((e) => error(e.message));
};
$("create-add").onclick = () => {
  if (editor.read().length < 16) {
    editor.add();
    dirty = true;
    $<HTMLButtonElement>("create-add").disabled = editor.read().length >= 16;
  }
};
$("create-close").onclick = () => {
  if (!saving && (!dirty || confirm("未保存の条件を破棄しますか？"))) {
    $("create-condition").hidden = true;
    dirty = false;
    if (draftKey) void chrome.storage.session.remove(draftKey);
    draftKey = "";
    render();
  }
};
$("create-save").onclick = () =>
  void (async () => {
    if (saving) return;
    saving = true;
    $<HTMLFieldSetElement>("create-fields").disabled = true;
    $("create-error").hidden = true;
    render();
    try {
      const applied = draftKey
        ? (await chrome.storage.session.get(draftKey))[draftKey]
        : undefined;
      if (applied?.applied) draftScope = validateScope(applied.scope);
      await saveRule(
        {
          id: editingRule?.id ?? crypto.randomUUID(),
          name: $<HTMLInputElement>("create-name").value,
          url: $<HTMLInputElement>("create-url").value,
          scope: $<HTMLSelectElement>("create-scope").value as UrlScope,
          enabled: editingRule?.enabled ?? true,
          criteria: editor.read(),
          contentScope: draftScope,
        },
        editingRule,
      );
      dirty = false;
      $("create-condition").hidden = true;
      await loadRules();
      if (draftKey) void chrome.storage.session.remove(draftKey);
      draftKey = "";
      $("progress").textContent = "対象と判定基準をセットで保存しました。";
    } catch (e) {
      $("create-error").hidden = false;
      $("create-error").textContent = (e as Error).message;
    } finally {
      saving = false;
      $<HTMLFieldSetElement>("create-fields").disabled = false;
      render();
    }
  })();
$("run").onclick = () =>
  void (async () => {
    if (!capture || starting) return;
    starting = true;
    error("");
    render();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "jev-run-page",
        tabId: capture.tabId,
        mode: "text",
      });
      if (response.error) throw new Error(response.error);
      $("progress").textContent = "ページ上に判定の進捗と結果を表示します。";
    } catch (e) {
      error((e as Error).message);
    } finally {
      starting = false;
      render();
    }
  })();
$("cancel").onclick = () => {
  if (capture && job)
    void chrome.runtime
      .sendMessage({
        type: "jev-cancel-page",
        tabId: capture.tabId,
        jobId: job.jobId,
      })
      .catch((e) => error((e as Error).message));
};
channel.onmessage = ({ data }: MessageEvent<JudgeMessage>) => {
  if (data.type === "status") {
    managers.set(data.status.id, { ...data.status, seen: Date.now() });
    render();
  }
  if (data.type === "closed") {
    managers.delete(data.managerId);
    render();
  }
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    void loadRules();
    if (
      Object.keys(changes).some((key) => key.startsWith("jev-content-scope:"))
    )
      void refreshSource();
  }
  if (area === "session") {
    const draft = draftKey ? changes[draftKey]?.newValue : undefined;
    if (draft?.applied && !$("create-condition").hidden) {
      draftScope = validateScope(draft.scope);
      $("create-target").textContent = `対象：${describeScope(draftScope)}`;
      void imagePermissions.update(draftScope, draftPageUrl);
      dirty = true;
    }
    if (windowId !== undefined) {
      const notice = changes[captureKey(windowId)]?.newValue as
        | CaptureNotice
        | undefined;
      if (notice) void receive(notice);
    }
    if (capture && changes[jobKey(capture.tabId)])
      updateJob(changes[jobKey(capture.tabId)].newValue);
  }
});
const heartbeat = setInterval(() => {
  for (const [id, engine] of managers)
    if (Date.now() - engine.seen > 30000) managers.delete(id);
  channel.postMessage({ type: "hello" } satisfies JudgeMessage);
  render();
}, 5000);
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  if (draftKey) void chrome.storage.session.remove(draftKey);
  clearInterval(heartbeat);
  channel.close();
});
channel.postMessage({ type: "hello" } satisfies JudgeMessage);
render();
void chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find(
    (command) => command.name === "evaluate-page",
  )?.shortcut;
  $("shortcut-hint").textContent = shortcut
    ? `パネルを開かずに判定：${shortcut}`
    : "ショートカットはChromeの拡張機能 → キーボードショートカットで設定できます。";
});
void (async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  if (windowId === undefined) return;
  // Always read the live tab: a session snapshot may belong to an old URL/tab.
  if (!fetchId) await refreshSource();
})().catch((e) => error((e as Error).message));
