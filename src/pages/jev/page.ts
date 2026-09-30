import "./page.css";
import { BatchPage } from "./batch-page";
import { ModelList } from "./model-list";
import { ServerPage } from "../../server/status-page";
import { SitePage } from "./site-page";
import { ManagerBridge } from "../../extension/judge-channel";
import { loadPageImages } from "../../extension/page-images";
import {
  matchesUrl,
  normalizeUrl,
  readRules,
} from "../../extension/site-rules";
declare const __JEVWEX_WEB__: boolean;
import {
  readImage,
  validateImageFiles,
  type InputImage,
} from "../../features/jev/images";
import { ModelManager } from "@wllama/wllama";
import { DecisionSession } from "../../inference/decision-session";
import { CloudModels } from "./cloud-models";
import { evaluateStoredCloud } from "../../extension/cloud-client";
import { createRuntime } from "../../inference/wllama-assets";
import {
  readLastModel,
  saveLastModel,
  LAST_MODEL_STORAGE_KEY,
} from "../../inference/last-model";
import { removeCachedModel } from "../../inference/model-removal";
import {
  chooseStartupModel,
  readRuntimeSettings,
  validateRuntimeSettings,
  RUNTIME_SETTINGS_KEY,
} from "../../inference/runtime-settings";
import {
  ModelDownload,
  EXAMPLE_MODEL_URL,
} from "../../inference/model-download";
import {
  asJevError,
  JevError,
  type JevInput,
  type LocalEvaluation,
} from "../../features/jev/types";
import { examples } from "../../features/jev/examples";
import { RequestState } from "./request-state";
import {
  DEFAULT_HARDWARE,
  HARDWARE_STORAGE_KEY,
  detectHardware,
  readHardware,
  resolveHardware,
  sameHardware,
  validateHardware,
  type HardwareCapabilities,
  type HardwareSettings,
} from "../../inference/hardware";
import {
  CriteriaEditor,
  buildInput,
  readable,
  typeNames,
  type Presentation,
} from "./criteria-editor";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
const state = new RequestState();
let images: { image: InputImage; url: string }[] = [];
let readingImages = false;
let batchPage: BatchPage | undefined;
let serverPage: ServerPage | undefined;
let sitePage: SitePage | undefined;
let managerBridge: ManagerBridge | undefined;
const editor = new CriteriaEditor($("criteria"), edited);
let result:
  | {
      evaluation: LocalEvaluation;
      input: JevInput;
      presentation: Presentation;
    }
  | undefined;
let operating = false,
  started = 0;
let cloudWasActive = false;
let cloudModels: CloudModels | undefined;
let deletingModel = false;
let deletingModelId: string | undefined;
let loadingModelId: string | undefined;
let hardware = readHardware(localStorage);
const lastModel = readLastModel(localStorage);
let startupOverridden = false;
let capabilities: HardwareCapabilities | undefined;
const session = new DecisionSession(
  createRuntime,
  renderSession,
  undefined,
  __JEVWEX_WEB__ ? undefined : evaluateStoredCloud,
);
let runtimeSettings = readRuntimeSettings(localStorage);
session.timeouts = {
  loadSeconds: runtimeSettings.loadSeconds,
  responseSeconds: runtimeSettings.responseSeconds,
};
const modelManager = new ModelManager({
  allowOffline: true,
  parallelDownloads: 1,
});
const download = new ModelDownload(modelManager);
const modelList = new ModelList(
  $("models"),
  (operation, id) => {
    if (operation === "remove") void action(() => removeModel(id));
    else if (
      operation === "load" &&
      session.cloud &&
      session.local.loaded?.model === id
    )
      void action(() => {
        if (modelOperationBusy()) return;
        session.useLocal();
        startupOverridden = true;
        edited();
      });
    else void action(() => operateModel(operation, id));
  },
  (operation, id) => cloudModels?.handle(operation, id),
);
cloudModels = new CloudModels(
  __JEVWEX_WEB__,
  session,
  modelOperationBusy,
  (busy) => {
    operating = busy;
    renderSession();
  },
  renderSession,
  () => {
    startupOverridden = true;
    edited();
  },
  action,
  showError,
);

function route(focus = false) {
  const current =
    sitePage && location.hash === "#sites"
      ? "sites"
      : location.hash === "#models"
        ? "models"
        : location.hash === "#hardware"
          ? "hardware"
          : location.hash === "#batch"
            ? "batch"
            : __JEVWEX_WEB__ && location.hash === "#server"
              ? "server"
              : "judge";
  const pages = {
    models: "model-page",
    judge: "judge-page",
    hardware: "hardware-page",
    batch: "batch-page",
    server: "server-page",
    sites: "sites-page",
  };
  const names = [
    "models",
    "judge",
    "hardware",
    "batch",
    ...(__JEVWEX_WEB__ && serverPage ? ["server"] : []),
    ...(sitePage ? ["sites"] : []),
  ] as (keyof typeof pages)[];
  for (const name of names) {
    const active = current === name;
    $(pages[name]).hidden = !active;
    if (active) $("nav-" + name).setAttribute("aria-current", "page");
    else $("nav-" + name).removeAttribute("aria-current");
  }
  document.title = `${current === "sites" ? "URL別の判定条件" : current === "models" ? "モデル管理" : current === "hardware" ? "ハードウェア設定" : current === "batch" ? "一括判定" : current === "server" ? "HTTP API" : "判定"} | JevWex`;
  if (current === "batch") batchPage?.enter();
  if (focus) {
    $(pages[current])
      .querySelector<HTMLElement>("h1")!
      .focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}
window.addEventListener("hashchange", () => route(true));

function renderSession() {
  if (cloudWasActive && !session.cloud) {
    $<HTMLInputElement>("cloud-key").value = "";
    $("cloud-status").textContent = "ローカルモデルを選択しました。";
  }
  cloudWasActive = !!session.cloud;
  managerBridge?.publish();
  const labels = {
    empty: "準備待ち",
    loading: "モデルを読み込んでいます",
    ready: "準備完了",
    running: "判定中",
    stopping: "中止処理中",
    error: "エラー",
  };
  $("status").textContent = labels[session.phase];
  const loaded = session.loaded;
  const loadedName = loaded
    ? session.cloud
      ? `JEV互換API：${cloudModels?.profiles.find((p) => p.id === session.cloud?.profileId)?.name ?? session.cloud.model} / ${session.cloud.model}`
      : (session.models.get(loaded.model)?.label ?? "選択したモデル")
    : "";
  $("loaded").textContent = loaded
    ? `準備完了：${loadedName}`
    : session.phase === "loading"
      ? "モデルを読み込んでいます…"
      : "モデルはまだ準備されていません";
  $("judge-model").textContent = loaded ? loadedName : "モデルが未準備です";
  $("model-hint").textContent = loaded
    ? hardwareSummary()
    : "モデル管理でモデルを追加し、読み込んでください。";
  $("model-dot").classList.toggle("ready", !!loaded);
  const cloud = session.cloud;
  $("external-transmission-warning").hidden = !cloud;
  $("external-transmission-destination").textContent = cloud
    ? new URL(cloud.endpoint).origin
    : "";
  $("privacy-note").textContent = cloud
    ? "API利用中：文章と判定基準を外部サイトへ送信します。"
    : "入力した文章と画像はこの端末で処理します。";
  $("privacy-note").classList.toggle("cloud-warning-note", !!cloud);
  $("run-hint").classList.toggle("cloud-warning-note", !!cloud);
  $("run-hint").textContent = loaded
    ? session.cloud
      ? `外部送信：文章と判定基準を ${new URL(session.cloud.endpoint).origin} に送信します。${session.cloud.fallback ? "失敗時はローカルで判定します。画像はローカルのみで処理します。" : "フォールバックは無効です。"}`
      : "入力した文章と画像はこの端末で処理します。"
    : "モデルを準備すると判定できます。";
  renderModels();
  $<HTMLInputElement>("files").disabled = deletingModel;
  $<HTMLButtonElement>("run").disabled =
    operating || readingImages || !loaded || session.phase !== "ready";
  $<HTMLButtonElement>("cancel").disabled =
    session.phase !== "running" || !!batchPage?.busy;
  batchPage?.refreshSession(
    !operating && !!loaded && session.phase === "ready",
    loaded
      ? `${loadedName} / ${hardwareSummary()}`
      : "モデル管理でモデルを準備してください。",
  );
  $("image-hint").textContent = loaded?.supports_images
    ? "現在のモデルは画像に対応しています。すべての判定基準に、追加した画像を渡します。"
    : loaded
      ? "現在のモデルは文章専用です。画像を判定するには、画像対応モデルと画像用ファイルを読み込んでください。"
      : "画像対応モデルを準備すると、画像を使って判定できます。";
  $("hardware-current").textContent = hardwareSummary();
  cloudModels?.render();
  $<HTMLButtonElement>("hardware-save").disabled = !capabilities;
  $<HTMLButtonElement>("hardware-apply").disabled =
    !capabilities ||
    operating ||
    !loaded ||
    !!session.cloud ||
    session.phase !== "ready";
}
function hardwareSummary() {
  if (session.cloud)
    return `JEV互換API / ${session.cloud.fallback ? "失敗時にローカルへフォールバック" : "フォールバックなし"}`;
  const loaded = session.loaded;
  if (!loaded) return "モデルはまだ読み込まれていません。";
  const info = loaded.hardware;
  const gpu =
    info?.requested.device === "webgpu"
      ? info.gpu_layers_offloaded === null
        ? "GPUを要求（使用層数は未確認）"
        : info.gpu_layers_offloaded > 0
          ? `GPU ${info.gpu_layers_offloaded}層`
          : "GPU使用なし（CPUで動作）"
      : "CPU";
  const projector = loaded.supports_images
    ? info?.requested.device === "webgpu" &&
      info.requested.mmprojDevice !== "cpu"
      ? " / mmproj GPUを要求"
      : " / mmproj CPU"
    : "";
  return `${gpu} / CPU ${loaded.threads}スレッド / 文章量 ${loaded.context.toLocaleString()}${projector}`;
}
function resolvedHardware() {
  if (!capabilities)
    throw new JevError(
      "BUSY",
      "ハードウェアを確認しています。少し待ってから試してください。",
    );
  return resolveHardware(hardware, capabilities);
}
async function loadAndRemember(id: string, remember = true) {
  loadingModelId = id;
  $("startup-status").textContent = "モデルを読み込んでいます…";
  try {
    await session.load(id, resolvedHardware());
  } catch (error) {
    $("startup-status").textContent = "";
    throw error;
  } finally {
    loadingModelId = undefined;
    renderModels();
  }
  const entry = session.models.get(id)!;
  const saved =
    !remember || saveLastModel(localStorage, { id, label: entry.label });
  $("startup-status").textContent = !saved
    ? "モデルは準備できましたが、前回のモデル情報を保存できませんでした。"
    : id.startsWith("cache:")
      ? "モデルを準備しました。次回の読み込みはハードウェア設定の「起動時のモデルと待ち時間」に従います。"
      : "最後に使ったモデル名と設定を保存しました。端末のファイルは次回も選択してください。";
  return saved;
}
function populateHardware(settings: HardwareSettings) {
  $<HTMLSelectElement>("hardware-mmproj").value =
    settings.mmprojDevice ?? "auto";
  $<HTMLSelectElement>("hardware-device").value = settings.device;
  const threads = $<HTMLSelectElement>("hardware-threads");
  if (
    settings.threads !== "auto" &&
    !Array.from(threads.options).some(
      (o) => o.value === String(settings.threads),
    )
  )
    threads.add(
      new Option(`${settings.threads}スレッド`, String(settings.threads)),
    );
  threads.value = String(settings.threads);
  const layers = $<HTMLSelectElement>("hardware-layers");
  if (
    !Array.from(layers.options).some(
      (o) => o.value === String(settings.gpuLayers),
    )
  )
    layers.add(
      new Option(`${settings.gpuLayers}層`, String(settings.gpuLayers)),
    );
  layers.value = String(settings.gpuLayers);
  $<HTMLSelectElement>("hardware-context").value = String(settings.context);
  $("gpu-layer-field").hidden = settings.device !== "webgpu";
}
function saveHardware() {
  const next = validateHardware({
    mmprojDevice: value("hardware-mmproj"),
    device: value("hardware-device"),
    threads:
      value("hardware-threads") === "auto"
        ? "auto"
        : Number(value("hardware-threads")),
    gpuLayers:
      value("hardware-layers") === "all"
        ? "all"
        : Number(value("hardware-layers")),
    context: Number(value("hardware-context")),
  });
  if (!capabilities) return;
  const resolved = resolveHardware(next, capabilities);
  localStorage.setItem(HARDWARE_STORAGE_KEY, JSON.stringify(next));
  hardware = next;
  const applied =
    session.loaded?.hardware &&
    sameHardware(resolved, session.loaded.hardware.requested);
  $("hardware-status").textContent = applied
    ? "保存しました。現在のモデルにも同じ設定が適用されています。"
    : session.loaded
      ? "保存しました。現在のモデルへの反映には「モデルを再読み込みして適用」を押してください。"
      : "保存しました。次にモデルを読み込むときに適用します。";
}
for (const id of [
  "hardware-device",
  "hardware-mmproj",
  "hardware-threads",
  "hardware-layers",
  "hardware-context",
])
  $(id).addEventListener("change", () => {
    $("gpu-layer-field").hidden = value("hardware-device") !== "webgpu";
    $("hardware-status").textContent =
      "未保存の変更があります。設定を保存するか、再読み込みして適用してください。";
  });
$("hardware-save").onclick = () => void action(saveHardware);
$("hardware-reset").onclick = () => {
  populateHardware(DEFAULT_HARDWARE);
  $("hardware-status").textContent =
    "初期値を表示しています。保存すると反映されます。";
};
$("hardware-apply").onclick = () =>
  void action(async () => {
    if (operating || session.phase !== "ready" || !session.loaded) return;
    saveHardware();
    const id = session.loaded.model;
    operating = true;
    state.cancel();
    edited();
    started = performance.now();
    renderSession();
    try {
      await loadAndRemember(id);
      $("hardware-status").textContent = "モデルに設定を適用しました。";
    } finally {
      operating = false;
      started = 0;
      renderSession();
    }
  });
populateHardware(hardware);
function populateFallbackModels(selected = value("runtime-fallback")) {
  const select = $<HTMLSelectElement>("runtime-fallback");
  select.replaceChildren(new Option("保存済みで最も小さいモデル", ""));
  for (const entry of session.models.values()) {
    if (entry.id.startsWith("cache:"))
      select.add(
        new Option(
          `${entry.label} / ${entry.size > 0 ? (entry.size / 1024 ** 3).toFixed(2) + " GiB" : "サイズ不明"}`,
          entry.id,
        ),
      );
  }
  if (
    selected &&
    !Array.from(select.options).some((option) => option.value === selected)
  )
    select.add(
      new Option(
        "指定したモデル（保存済みファイルが見つかりません）",
        selected,
      ),
    );
  select.value = selected;
}
$<HTMLSelectElement>("runtime-startup").value = runtimeSettings.startup;
$<HTMLInputElement>("runtime-max-size").value = String(
  runtimeSettings.maxAutoLoadGiB,
);
$<HTMLInputElement>("runtime-load-seconds").value = String(
  runtimeSettings.loadSeconds,
);
$<HTMLInputElement>("runtime-response-seconds").value = String(
  runtimeSettings.responseSeconds,
);
populateFallbackModels(runtimeSettings.fallbackModel);
$("runtime-save").onclick = () =>
  void action(() => {
    const next = validateRuntimeSettings({
      startup: value("runtime-startup"),
      maxAutoLoadGiB: Number(value("runtime-max-size")),
      fallbackModel: value("runtime-fallback"),
      loadSeconds: Number(value("runtime-load-seconds")),
      responseSeconds: Number(value("runtime-response-seconds")),
    });
    localStorage.setItem(RUNTIME_SETTINGS_KEY, JSON.stringify(next));
    runtimeSettings = next;
    session.timeouts = {
      loadSeconds: next.loadSeconds,
      responseSeconds: next.responseSeconds,
    };
    managerBridge?.publish();
    $("runtime-status").textContent =
      "保存しました。起動設定は次回、待ち時間は次の処理から反映します。";
  });
for (const id of [
  "runtime-startup",
  "runtime-max-size",
  "runtime-fallback",
  "runtime-load-seconds",
  "runtime-response-seconds",
])
  $(id).addEventListener("input", () => {
    $("runtime-status").textContent = "未保存の変更があります。";
  });
const hardwareReady = detectHardware().then((caps) => {
  capabilities = caps;
  $("hardware-cpu").textContent =
    `CPU：${caps.cores}論理コア / ${caps.multiThread ? "複数スレッドを利用できます" : "1スレッドのみ利用できます"}`;
  $("hardware-gpu").textContent = `GPU：${caps.gpuName}`;
  $("hardware-gpu-reason").textContent = caps.gpuReason;
  $<HTMLOptionElement>("gpu-option").disabled = !caps.gpu;
  const threads = $<HTMLSelectElement>("hardware-threads");
  threads.replaceChildren(new Option("自動", "auto"));
  for (let n = 1; n <= (caps.multiThread ? Math.min(32, caps.cores) : 1); n++)
    threads.add(new Option(`${n}スレッド`, String(n)));
  populateHardware(hardware);
  renderSession();
});
function showError(error: unknown) {
  const e = asJevError(error);
  const alias = e.question
    ? (editor.read().find((d) => d.id === e.question)?.alias ?? "判定基準")
    : "";
  const messages: Partial<Record<typeof e.code, string>> = {
    CONTEXT_LIMIT:
      "文章・画像・判定基準がモデルの処理できる量を超えています。画像を減らすか、ハードウェア設定で扱える量を増やしてください。",
    INVALID_OUTPUT: e.message,
    OUTPUT_LIMIT:
      "モデルの回答が長くなりすぎました。判定する内容・条件を短くするか、別のモデルで試してください。",
    CANCELLED: "判定を中止しました。",
  };
  $("error").hidden = false;
  $("error").textContent =
    `${alias ? `「${alias}」：` : ""}${messages[e.code] ?? e.message}`;
  $("status").textContent =
    e.code === "CANCELLED" ? "中止しました" : "内容を確認してください";
}
function clearError() {
  $("error").hidden = true;
}
function edited() {
  state.edit();
  const count = $("criteria").children.length;
  $("criteria-count").textContent = `${count}件`;
  $<HTMLButtonElement>("add-criterion").disabled = count >= 16;
  if (result)
    $("result-note").textContent =
      "入力またはモデルが変更されています。表示中の結果は前回の判定です。";
}
function populate(input: JevInput) {
  // Examples are presented as prose; users never need to edit a serialized object.
  const source = input.state;
  $<HTMLTextAreaElement>("state").value =
    typeof source === "object" && !Array.isArray(source) && "message" in source
      ? `${String(source.message)}${source.order_status ? `\n注文状況：${source.order_status === "delivered" ? "配達済み" : String(source.order_status)}` : ""}`
      : readable(source);
  editor.populate(input);
  const choice = $("criteria").querySelector('[data-id="department"]');
  if (choice) {
    const names = ["請求・返金", "配送", "その他"];
    choice
      .querySelectorAll<HTMLInputElement>('[data-field="label"]')
      .forEach((el, i) => (el.value = names[i]));
  }
  edited();
}
async function action(fn: () => void | Promise<void>) {
  clearError();
  try {
    await fn();
  } catch (e) {
    showError(e);
  }
}
function renderResult(
  data: LocalEvaluation,
  input: JevInput,
  presentation: Presentation,
) {
  result = { evaluation: data, input, presentation };
  $("result-note").textContent =
    `判定が完了しました（${(data.diagnostics.evaluation_ms / 1000).toFixed(1)}秒）。使用モデル：${data.response.model}。${data.diagnostics.fallback ? `ローカルへフォールバック：${data.diagnostics.fallback.reason}` : data.diagnostics.provider === "jev" ? "確率はクラウドAPIの返却値です。" : "割合はモデルの重みを正規化した値です。"} 正答率ではありません。`;
  $("results").replaceChildren();
  for (const [id, answer] of Object.entries(data.response.answers)) {
    const meta = presentation[id];
    const card = document.createElement("article");
    card.className = "answer";
    const heading = document.createElement("div");
    heading.className = "answer-heading";
    const title = document.createElement("h3");
    title.textContent = meta.alias;
    const tag = document.createElement("span");
    tag.className = "type-tag";
    tag.textContent = typeNames[answer.type];
    heading.append(title, tag);
    card.append(heading);
    const main = document.createElement("div");
    main.className = "value";
    main.textContent =
      answer.type === "choice"
        ? answer.choice
        : answer.type === "noul"
          ? `当てはまり ${(answer.noul * 100).toFixed(1)}%`
          : `${Number(answer.score.toFixed(2))} / ${meta.labels.length - 1} 点`;
    card.append(main);
    if (answer.type !== "noul") {
      const hint = document.createElement("p");
      hint.className = "muted";
      hint.textContent = "候補間の確率（正答率ではありません）";
      card.append(hint);
      for (const [label, p] of Object.entries(answer.probabilities)) {
        const line = document.createElement("div");
        line.className = "distribution";
        const name = document.createElement("span");
        name.textContent =
          answer.type === "score"
            ? `${label}：${meta.labels[Number(label)]}`
            : label;
        const meter = document.createElement("meter");
        meter.min = 0;
        meter.max = 1;
        meter.value = p;
        meter.setAttribute("aria-label", name.textContent);
        const number = document.createElement("span");
        number.textContent = (p * 100).toFixed(1) + "%";
        line.append(name, meter, number);
        card.append(line);
      }
      const confidence = document.createElement("p");
      confidence.className = "muted";
      confidence.textContent = `重みの集中度：${Math.round(answer.confidence * 100)}%（回答の正しさを保証する値ではありません）`;
      card.append(confidence);
    }
    $("results").append(card);
  }
  $<HTMLButtonElement>("download-result").disabled = false;
}
function cacheLabel(url: string) {
  return decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
}
function refreshModels() {
  populateFallbackModels();
  renderSession();
}
function modelOperationBusy() {
  return (
    operating ||
    download.busy ||
    !!batchPage?.busy ||
    ["loading", "running", "stopping"].includes(session.phase)
  );
}
function renderModels() {
  $("models-empty").hidden =
    session.models.size > 0 || !!cloudModels?.profiles.length;
  modelList.render(session.models.values(), {
    loadedId: session.local.loaded?.model,
    standby: !!session.cloud,
    loadingId: loadingModelId,
    deletingId: deletingModelId,
    phase: session.phase,
    busy: modelOperationBusy() || $<HTMLButtonElement>("download").disabled,
    canLoad: !!capabilities,
  });
  modelList.renderCloud(
    cloudModels?.profiles ?? [],
    session.cloud?.profileId,
    modelOperationBusy() || !!cloudModels?.loading,
  );
}
$("files").addEventListener(
  "change",
  () =>
    void action(() => {
      const files = Array.from($<HTMLInputElement>("files").files ?? []).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
      if (!files.length) return;
      if (files.some((f) => !f.name.toLowerCase().endsWith(".gguf") || !f.size))
        throw new JevError(
          "INVALID_REQUEST",
          "空でないGGUFファイルを選択してください。",
        );
      const id =
        "local:" +
        files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join("|");
      session.register({
        id,
        label: files.map((f) => f.name).join(" + "),
        size: files.reduce((n, f) => n + f.size, 0),
        source: files,
      });
      refreshModels();
      edited();
    }),
);
async function removeModel(id: string) {
  $("model-remove-status").textContent = "";
  const entry = session.models.get(id);
  if (
    !entry ||
    operating ||
    download.busy ||
    batchPage?.busy ||
    ["loading", "running", "stopping"].includes(session.phase)
  )
    return;
  const local = Array.isArray(entry.source);
  const message = local
    ? `「${entry.label}」を一覧から削除しますか？ 端末の元ファイルは削除しません。`
    : `「${entry.label}」をブラウザの保存領域から削除しますか？ 再度使う場合はダウンロードが必要です。ほかのモデルと共有している画像用ファイルは残します。`;
  if (
    !confirm(
      message +
        (session.local.loaded?.model === entry.id
          ? " 現在のモデルの使用も終了します。"
          : ""),
    )
  )
    return;
  deletingModel = true;
  deletingModelId = id;
  operating = true;
  downloadControls(true);
  state.cancel();
  edited();
  renderSession();
  $("model-remove-status").textContent = "削除しています…";
  try {
    if (session.local.loaded?.model === entry.id) await session.unload();
    const removed = !Array.isArray(entry.source)
      ? await removeCachedModel(modelManager.cacheManager, entry.source)
      : undefined;
    session.models.delete(entry.id);
    if (session.selected === entry.id)
      session.selected = session.loaded?.model ?? "";
    $<HTMLInputElement>("files").value = "";
    if (readLastModel(localStorage)?.id === entry.id)
      localStorage.removeItem(LAST_MODEL_STORAGE_KEY);
    if (runtimeSettings.fallbackModel === entry.id) {
      runtimeSettings = { ...runtimeSettings, fallbackModel: "" };
      localStorage.setItem(
        RUNTIME_SETTINGS_KEY,
        JSON.stringify(runtimeSettings),
      );
    }
    if (value("runtime-fallback") === entry.id)
      $<HTMLSelectElement>("runtime-fallback").value = "";
    $("startup-status").textContent = "";
    $("model-remove-status").textContent = local
      ? "一覧から削除しました。端末の元ファイルは残っています。"
      : `保存済みモデルを削除しました。${removed?.sharedProjector ? "共有の画像用ファイルは残しています。" : ""}`;
  } catch (error) {
    $("model-remove-status").textContent =
      "削除を完了できませんでした。エラーを確認して再度お試しください。";
    throw error;
  } finally {
    deletingModel = false;
    deletingModelId = undefined;
    operating = false;
    downloadControls(false);
    refreshModels();
  }
}
async function operateModel(operation: "load" | "unload", id: string) {
  if (
    modelOperationBusy() ||
    !session.models.has(id) ||
    (operation === "unload" && session.local.loaded?.model !== id)
  )
    return;
  session.selected = id;
  operating = true;
  state.cancel();
  edited();
  renderSession();
  started = performance.now();
  try {
    if (operation === "load") await loadAndRemember(id);
    else await session.unload();
  } finally {
    operating = false;
    started = 0;
    renderSession();
  }
}
$("run").onclick = () =>
  void action(async () => {
    if (session.phase !== "ready" || operating) return;
    const { input, presentation } = buildInput(
      value("state").trim() ||
        (images.length ? "添付画像を判定してください。" : ""),
      editor.read(),
    );
    session.resolveModel(input);
    const ticket = state.begin();
    started = performance.now();
    if (result)
      $("result-note").textContent =
        "前回の結果です。新しい判定を実行しています。";
    try {
      const data = await session.evaluate(
        input,
        undefined,
        images.map((item) => item.image),
      );
      if (state.accepts(ticket)) renderResult(data, input, presentation);
      else
        $("result-note").textContent =
          "実行中に入力・モデルが変更されたため、今回の結果を破棄しました。再度判定してください。";
    } catch (e) {
      if (state.accepts(ticket)) throw e;
    } finally {
      if (!operating) started = 0;
    }
  });
$("cancel").onclick = () =>
  void action(async () => {
    if (batchPage?.busy) return;
    state.cancel();
    await session.stop();
    $("status").textContent = "中止しました";
    $("result-note").textContent = result
      ? "前回の結果です。今回の判定は中止しました。"
      : "判定を中止しました。";
    started = 0;
  });
$("state").addEventListener("input", edited);
$("add-criterion").onclick = () => {
  if ($("criteria").children.length < 16) {
    editor.add();
    edited();
  }
};
examples.forEach((example, i) =>
  $<HTMLSelectElement>("examples").add(new Option(example.name, String(i))),
);
$("sample").onclick = () => {
  populate(examples[Number(value("examples"))].input);
  clearError();
};
$("download-result").onclick = () => {
  if (!result) return;
  const payload = {
    ...result.evaluation,
    input: result.input,
    presentation: result.presentation,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `jevwex-result-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener("pagehide", () => {
  managerBridge?.close();
  void serverPage?.disconnect();
  batchPage?.dispose();
  download.cancel();
  session.dispose();
  for (const item of images) URL.revokeObjectURL(item.url);
});
setInterval(() => {
  if (started)
    $("elapsed").textContent =
      `経過 ${((performance.now() - started) / 1000).toFixed(1)} 秒`;
}, 100);
populate(examples[0].input);
route();
renderSession();
const modelsReady = modelManager
  .getModels()
  .then((models) => {
    const selected = session.selected;
    for (const model of models)
      session.register({
        id: `cache:${model.url}`,
        label:
          cacheLabel(model.url) + (model.mmprojUrl ? " ＋ 画像用ファイル" : ""),
        size: model.size,
        source: model,
      });
    session.selected = selected;
    refreshModels();
    return true;
  })
  .catch(() => {
    $("cache-warning").textContent =
      "保存済みモデルの一覧を取得できませんでした。端末のファイルから追加できます。";
    return false;
  });
// An explicit model/settings interaction during startup takes priority over restoration.
for (const id of ["model-page", "hardware-page"]) {
  $(id).addEventListener("change", () => {
    startupOverridden = true;
  });
  $(id).addEventListener("input", () => {
    startupOverridden = true;
  });
  $(id).addEventListener(
    "click",
    (event) => {
      if ((event.target as HTMLElement).closest("button,input,select"))
        startupOverridden = true;
    },
    true,
  );
}
if (lastModel)
  $("startup-status").textContent =
    `前回のモデル「${lastModel.label}」を確認しています…`;
void Promise.all([hardwareReady, modelsReady])
  .then(async ([, cacheReady]) => {
    if (!lastModel) return;
    if (startupOverridden || operating || session.loaded) {
      $("startup-status").textContent =
        "モデルや設定が操作されたため、自動読み込みは行いません。";
      return;
    }
    if (!cacheReady) {
      $("startup-status").textContent =
        "前回のモデルを確認できませんでした。モデル管理でモデルを選択してください。";
      return;
    }
    const startup = chooseStartupModel(runtimeSettings, lastModel.id, [
      ...session.models.values(),
    ]);
    $("startup-status").textContent = startup.message;
    if (!startup.model) return;
    const startupModel = startup.model;
    session.selected = startupModel.id;
    operating = true;
    started = performance.now();
    refreshModels();
    $("startup-status").textContent = `${startup.message} 読み込み中…`;
    try {
      if (await loadAndRemember(startupModel.id, false))
        $("startup-status").textContent =
          `${startup.message}「${startupModel.label}」を読み込みました。`;
    } catch (error) {
      $("startup-status").textContent =
        `自動読み込みができませんでした。モデル管理またはハードウェア設定を確認してください：${asJevError(error).message}`;
    } finally {
      operating = false;
      started = 0;
      renderSession();
    }
  })
  .catch((error) => {
    $("startup-status").textContent =
      `起動時の確認に失敗しました：${asJevError(error).message}`;
  });
function downloadControls(busy: boolean) {
  for (const id of [
    "download",
    "download-example",
    "download-vision-example",
    "download-url",
    "download-projector",
  ])
    $<HTMLInputElement>(id).disabled = busy;
  $<HTMLButtonElement>("download-cancel").disabled = !busy || deletingModel;
  renderModels();
}
$("download-example").onclick = () => {
  $<HTMLInputElement>("download-url").value = EXAMPLE_MODEL_URL;
};
$("download-vision-example").onclick = () => {
  $<HTMLInputElement>("download-url").value = "LiquidAI/LFM2.5-VL-3B-GGUF";
  $<HTMLInputElement>("download-projector").value = "";
};
$("download-cancel").onclick = () => {
  download.cancel();
  $("download-status").textContent = "中止処理中…";
  $<HTMLButtonElement>("download-cancel").disabled = true;
};
$("download").onclick = () => {
  if (download.busy || $<HTMLButtonElement>("download").disabled) return;
  const url = value("download-url"),
    selected = session.selected;
  downloadControls(true);
  const progress = $<HTMLProgressElement>("download-progress");
  progress.hidden = false;
  progress.removeAttribute("value");
  $("download-status").textContent = "接続中・サイズ確認中…";
  $("download-resolved").textContent = "";
  void (async () => {
    try {
      const model = await download.download(
        url,
        ({ loaded, total }) => {
          if (total > 0) progress.value = Math.min(1, loaded / total);
          else progress.removeAttribute("value");
          $("download-status").textContent =
            `取得中 ${(loaded / 1048576).toFixed(1)} MiB / ${total > 0 ? (total / 1048576).toFixed(1) + " MiB" : "サイズ不明"}`;
        },
        (resolved, projector) => {
          $("download-resolved").textContent =
            `取得ファイル：${cacheLabel(resolved)}${projector ? " ＋ 画像用ファイル：" + cacheLabel(projector) : ""}`;
        },
        value("download-projector"),
      );
      const current = session.selected;
      session.register({
        id: `cache:${model.url}`,
        label:
          cacheLabel(model.url) + (model.mmprojUrl ? " ＋ 画像用ファイル" : ""),
        size: model.size,
        source: model,
      });
      if (current !== selected) session.selected = current;
      else edited();
      refreshModels();
      progress.value = 1;
      $("download-status").textContent =
        "保存完了。「読み込む」を押すと判定に使えます。";
    } catch (error) {
      $("download-status").textContent = asJevError(error).message;
      progress.hidden = true;
    } finally {
      downloadControls(false);
    }
  })();
};

function renderImages() {
  $("image-previews").replaceChildren();
  for (const item of images) {
    const card = document.createElement("figure");
    const preview = document.createElement("img");
    preview.src = item.url;
    preview.alt = item.image.name;
    const caption = document.createElement("figcaption");
    caption.textContent = `${item.image.name} · ${item.image.width} × ${item.image.height}`;
    const remove = document.createElement("button");
    remove.className = "secondary";
    remove.textContent = "× 削除";
    remove.setAttribute("aria-label", `${item.image.name}を削除`);
    remove.onclick = () => {
      images = images.filter((candidate) => candidate !== item);
      URL.revokeObjectURL(item.url);
      edited();
      renderImages();
    };
    card.append(preview, caption, remove);
    $("image-previews").append(card);
  }
}
$("images").addEventListener(
  "change",
  () =>
    void action(async () => {
      const picker = $<HTMLInputElement>("images");
      const files = Array.from(picker.files ?? []);
      picker.value = "";
      if (!files.length || readingImages) return;
      validateImageFiles(files, images.length);
      readingImages = true;
      picker.disabled = true;
      edited();
      renderSession();
      try {
        const decoded: InputImage[] = [];
        for (const file of files) decoded.push(await readImage(file));
        images.push(
          ...decoded.map((image) => ({
            image,
            url: URL.createObjectURL(
              new Blob([image.data], { type: image.type }),
            ),
          })),
        );
        edited();
        renderImages();
      } finally {
        readingImages = false;
        picker.disabled = false;
        renderSession();
      }
    }),
);

batchPage = new BatchPage({
  session,
  getCriteria: () => editor.read(),
  canStart: () => !operating && session.phase === "ready" && !!session.loaded,
  setBusy: (busy) => {
    operating = busy;
    started = busy ? performance.now() : 0;
    renderSession();
  },
});
if (__JEVWEX_WEB__) serverPage = new ServerPage();
else {
  document.querySelector("footer")!.textContent =
    "既定は端末内で判定します。JEV互換APIを選ぶと文章・判定基準を設定した送信先へ送ります。保存したURL・条件は拡張内に残り、ページ内容はブラウザ終了まで一時保持します。結果は自動保存しません。";
  sitePage = new SitePage(() => editor.read());
  const manage = (destination: "models" | "sites", url?: string) => {
    if (url) {
      void action(() =>
        sitePage!.open({
          id: crypto.randomUUID(),
          name: "ページの判定条件",
          url: normalizeUrl(url),
          scope: "exact",
          enabled: true,
          criteria: editor.read(),
        }),
      );
    } else location.hash = destination;
  };
  managerBridge = new ManagerBridge({
    status: () => ({
      responseSeconds: runtimeSettings.responseSeconds,
      cloudSeconds: session.cloud?.timeoutSeconds,
      inputContext: session.local.loaded?.context ?? hardware.context,
      supportsImages: session.loaded?.supports_images === true,
      ready:
        !operating &&
        !readingImages &&
        session.phase === "ready" &&
        !!session.loaded,
      model: session.loaded
        ? session.cloud
          ? `クラウド：${session.cloud.model}（文章の送信先：${new URL(session.cloud.endpoint).origin}）`
          : (session.models.get(session.loaded.model)?.label ??
            "読み込み済みモデル")
        : "",
      phase:
        session.phase === "loading"
          ? "モデル読み込み中"
          : operating || session.phase === "running"
            ? "判定中"
            : session.phase === "ready"
              ? "準備完了"
              : "モデルを準備してください",
    }),
    evaluate: async (request, signal) => {
      if (operating || session.phase !== "ready")
        throw new Error("別の処理を実行中です。");
      operating = true;
      started = performance.now();
      renderSession();
      try {
        const rule = (await readRules()).find(
          (rule) => rule.id === request.ruleId,
        );
        signal.throwIfAborted();
        if (!rule || !matchesUrl(rule, request.url))
          throw new Error(
            "このURLの条件が削除・変更されています。条件を選び直してください。",
          );
        if (request.images?.length && !session.loaded?.supports_images)
          throw new Error(
            "現在のモデルは画像を読み取れません。画像対応モデルと画像用ファイルを読み込んでください。",
          );
        const images = await loadPageImages(request.images ?? [], signal);
        const { input, presentation } = buildInput(
          request.text || (images.length ? "添付画像を判定してください。" : ""),
          rule.criteria,
        );
        const evaluation = await session.evaluate(input, signal, images);
        return { evaluation, input, presentation };
      } finally {
        operating = false;
        started = 0;
        renderSession();
      }
    },
    cancel: () => session.stop(),
    manage,
  });
  const siteUrl = new URLSearchParams(location.search).get("siteUrl");
  if (siteUrl) {
    history.replaceState(null, "", location.pathname + "#sites");
    manage("sites", siteUrl);
  }
}
route();
renderSession();
