import "./page.css";
import { BatchPage } from "./batch-page";
import {
  readImage,
  validateImageFiles,
  type InputImage,
} from "../../features/jev/images";
import { ModelManager } from "@wllama/wllama";
import { ModelSession } from "../../inference/model-session";
import { createRuntime } from "../../inference/wllama-assets";
import { readLastModel, saveLastModel } from "../../inference/last-model";
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
const editor = new CriteriaEditor($("criteria"), edited);
let result:
  | { evaluation: LocalEvaluation; input: JevInput; presentation: Presentation }
  | undefined;
let operating = false,
  started = 0;
let hardware = readHardware(localStorage);
const lastModel = readLastModel(localStorage);
let startupOverridden = false;
let capabilities: HardwareCapabilities | undefined;
const session = new ModelSession(createRuntime, renderSession);
const modelManager = new ModelManager({
  allowOffline: true,
  parallelDownloads: 1,
});
const download = new ModelDownload(modelManager);

function route(focus = false) {
  const current =
    location.hash === "#models"
      ? "models"
      : location.hash === "#hardware"
        ? "hardware"
        : location.hash === "#batch"
          ? "batch"
          : "judge";
  const pages = {
    models: "model-page",
    judge: "judge-page",
    hardware: "hardware-page",
    batch: "batch-page",
  };
  for (const name of ["models", "judge", "hardware", "batch"] as const) {
    const active = current === name;
    $(pages[name]).hidden = !active;
    if (active) $("nav-" + name).setAttribute("aria-current", "page");
    else $("nav-" + name).removeAttribute("aria-current");
  }
  document.title = `${current === "models" ? "モデル管理" : current === "hardware" ? "ハードウェア設定" : current === "batch" ? "一括判定" : "判定"} | JevWex`;
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
  const labels = {
    empty: "準備待ち",
    loading: "モデルを読み込んでいます",
    ready: "準備完了",
    running: "判定中",
    stopping: "中止処理中",
    error: "エラー",
  };
  $("status").textContent = labels[session.phase];
  const selected = session.models.get(session.selected),
    loaded = session.loaded;
  const loadedName = loaded
    ? (session.models.get(loaded.model)?.label ?? "選択したモデル")
    : "";
  $("selection").textContent = selected
    ? `${selected.label} / ${selected.size < 0 ? "サイズ不明" : (selected.size / 1048576).toFixed(1) + " MiB"}`
    : "モデルを選択してください。";
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
  $("run-hint").textContent = loaded
    ? "入力した文章と画像はこの端末で処理します。"
    : "モデルを準備すると判定できます。";
  $<HTMLButtonElement>("load").disabled =
    operating || !selected || !capabilities;
  $<HTMLButtonElement>("unload").disabled = operating || !loaded;
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
  $<HTMLButtonElement>("hardware-save").disabled = !capabilities;
  $<HTMLButtonElement>("hardware-apply").disabled =
    !capabilities || operating || !loaded || session.phase !== "ready";
}
function hardwareSummary() {
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
  return `${gpu} / CPU ${loaded.threads}スレッド / 文章量 ${loaded.context.toLocaleString()}`;
}
function resolvedHardware() {
  if (!capabilities)
    throw new JevError(
      "BUSY",
      "ハードウェアを確認しています。少し待ってから試してください。",
    );
  return resolveHardware(hardware, capabilities);
}
async function loadAndRemember(id: string) {
  $("startup-status").textContent = "モデルを読み込んでいます…";
  try {
    await session.load(id, resolvedHardware());
  } catch (error) {
    $("startup-status").textContent = "";
    throw error;
  }
  const entry = session.models.get(id)!;
  const saved = saveLastModel(localStorage, { id, label: entry.label });
  $("startup-status").textContent = !saved
    ? "モデルは準備できましたが、前回のモデル情報を保存できませんでした。"
    : id.startsWith("cache:")
      ? "次回はこのモデルを保存済みのハードウェア設定で自動的に読み込みます。"
      : "最後に使ったモデル名と設定を保存しました。端末のファイルは次回も選択してください。";
  return saved;
}
function populateHardware(settings: HardwareSettings) {
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
    INVALID_OUTPUT:
      e.message,
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
    `判定が完了しました（${(data.diagnostics.evaluation_ms / 1000).toFixed(1)}秒）。割合はモデルの重みを正規化した値で、正答率ではありません。`;
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
  const select = $<HTMLSelectElement>("models");
  select.replaceChildren(new Option("モデルを選択してください", ""));
  for (const entry of session.models.values())
    select.add(new Option(entry.label, entry.id));
  select.value = session.selected;
  renderSession();
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
$("models").addEventListener("change", () => {
  session.selected = value("models");
  edited();
  renderSession();
});
for (const id of ["load", "unload"])
  $(id).onclick = () =>
    void action(async () => {
      if (operating) return;
      operating = true;
      state.cancel();
      edited();
      renderSession();
      started = performance.now();
      try {
        if (id === "load") await loadAndRemember(session.selected);
        else await session.unload();
      } finally {
        operating = false;
        started = 0;
        renderSession();
      }
    });
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
    if (!session.models.has(lastModel.id)) {
      $("startup-status").textContent = lastModel.id.startsWith("local:")
        ? `前回使用：${lastModel.label}。モデル管理で同じ端末のファイルを選択してください。設定は保存されています。`
        : `前回使用：${lastModel.label}。保存済みファイルが見つかりません。モデル管理で再度追加してください。`;
      return;
    }
    session.selected = lastModel.id;
    operating = true;
    started = performance.now();
    refreshModels();
    $("startup-status").textContent =
      `前回のモデル「${lastModel.label}」を自動で読み込んでいます…`;
    try {
      if (await loadAndRemember(lastModel.id))
        $("startup-status").textContent =
          "前回のモデルを読み込みました。すぐに判定できます。";
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
  $<HTMLButtonElement>("download-cancel").disabled = !busy;
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
route();
renderSession();
