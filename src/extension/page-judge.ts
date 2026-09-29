import { captureTab, type PageCapture } from "./capture";
import {
  JUDGE_CHANNEL,
  type JudgeMessage,
  type ManagerStatus,
  type WebRequest,
  type WebResult,
} from "./judge-channel";
import { matchingRules, readRules } from "./site-rules";
import { showOverlay, summarizeResult, type OverlayData } from "./overlay";

export const jobKey = (tabId: number) => `jev-page-job:${tabId}`;
export type CaptureMode = "auto" | "text" | "selection";
export function pageInputs(capture: PageCapture, mode: CaptureMode) {
  const selection =
    mode === "selection" ||
    (mode === "auto" && !capture.items && !!capture.selection);
  if (!selection && capture.items)
    return capture.items.map(
      ({ text, truncated, images, target, ...item }) => ({
        text,
        truncated,
        ...(target ? { target } : {}),
        ...(images ? { images } : {}),
        item,
      }),
    );
  return [
    {
      text: selection ? capture.selection : capture.text,
      truncated: selection ? capture.selectionTruncated : capture.truncated,
      item: undefined,
      ...(!selection && capture.target ? { target: capture.target } : {}),
      ...(!selection && capture.images ? { images: capture.images } : {}),
    },
  ];
}
class InferenceUnavailable extends Error {}
interface Job {
  id: string;
  tabId: number;
  controller: AbortController;
  capture?: PageCapture;
  data?: OverlayData;
}
const jobs = new Map<number, Job>();

// A short-lived client exists only during a page judgement, including shortcuts.
// It does not require a panel document to exist.
class InferenceClient {
  private channel = new BroadcastChannel(JUDGE_CHANNEL);
  private statuses = new Map<string, ManagerStatus>();
  private pending?: {
    request: WebRequest;
    resolve: (result: WebResult) => void;
    reject: (e: Error) => void;
  };
  constructor() {
    this.channel.onmessage = ({ data }: MessageEvent<JudgeMessage>) => {
      if (data.type === "status")
        this.statuses.set(data.status.id, data.status);
      if (data.type === "closed") {
        this.statuses.delete(data.managerId);
        if (this.pending?.request.managerId === data.managerId)
          this.pending.reject(
            new InferenceUnavailable(
              "管理画面との接続が切れました。モデルを準備し直してください。",
            ),
          );
      }
      if (
        data.type === "result" &&
        data.requestId === this.pending?.request.requestId &&
        data.clientId === this.pending.request.clientId &&
        data.managerId === this.pending.request.managerId
      ) {
        if (data.error || !data.result)
          this.pending.reject(
            new Error(data.error ?? "判定結果を取得できませんでした。"),
          );
        else this.pending.resolve(data.result);
      }
    };
  }
  async discover(signal: AbortSignal) {
    this.channel.postMessage({ type: "hello" } satisfies JudgeMessage);
    // Existing manager tabs reply immediately; allow all tabs to advertise.
    for (let n = 0; n < 20; n++) {
      signal.throwIfAborted();
      const manager = [...this.statuses.values()].find(
        (status) => status.ready,
      );
      if (manager) return manager;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      "管理画面でモデルを読み込み、ほかの判定が終わってから再実行してください。管理用タブは開いたままにします。",
    );
  }
  async evaluate(request: WebRequest, signal: AbortSignal): Promise<WebResult> {
    signal.throwIfAborted();
    if (!this.statuses.has(request.managerId))
      throw new InferenceUnavailable("管理画面との接続が切れました。");
    let abort!: () => void;
    const timeout = setTimeout(
      () =>
        this.pending?.reject(
          new InferenceUnavailable(
            "判定が時間内に完了しませんでした。文章を短くして再実行してください。",
          ),
        ),
      240000,
    );
    try {
      return await new Promise<WebResult>((resolve, reject) => {
        this.pending = { request, resolve, reject };
        abort = () => {
          this.channel.postMessage({
            type: "cancel",
            ...request,
          } satisfies JudgeMessage);
          reject(new Error("判定を中止しました。"));
        };
        signal.addEventListener("abort", abort, { once: true });
        this.channel.postMessage({
          type: "evaluate",
          request,
        } satisfies JudgeMessage);
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      // Also release inference after a timeout or management disconnect.
      this.channel.postMessage({
        type: "cancel",
        ...request,
      } satisfies JudgeMessage);
      this.pending = undefined;
    }
  }
  close() {
    this.channel.close();
  }
}

async function publish(job: Job) {
  if (!job.data) return;
  if (job.capture) {
    // A replaced document cannot receive an overlay. Still persist the terminal
    // state so a reopened panel never remains stuck on a departed page's job.
    const visible = await showOverlay(job.capture, job.data).catch(() => false);
    if (!visible) {
      job.controller.abort();
      if (job.data.phase === "complete") {
        job.data.phase = "cancelled";
        job.data.message = "表示先のページが変わったため、結果を破棄しました。";
      }
    }
  }
  await chrome.storage.session.set({
    [jobKey(job.tabId)]: {
      jobId: job.id,
      phase: job.data.phase,
      message: job.data.message,
    },
  });
}
export function cancelPageJudge(tabId: number, jobId?: string) {
  const job = jobs.get(tabId);
  if (job && (!jobId || job.id === jobId)) job.controller.abort();
}
export function startPageJudge(tabId: number, mode: CaptureMode = "auto") {
  if (jobs.has(tabId))
    throw new Error(
      "このページは判定中です。オーバーレイの中止ボタンを使ってください。",
    );
  const job: Job = {
    id: crypto.randomUUID(),
    tabId,
    controller: new AbortController(),
  };
  jobs.set(tabId, job);
  void run(job, mode);
  return job.id;
}
async function run(job: Job, mode: CaptureMode) {
  const client = new InferenceClient();
  const signal = job.controller.signal;
  // Keep the service worker alive only while this user-requested job is running.
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
  try {
    await chrome.action.setBadgeText({ tabId: job.tabId, text: "" });
    await chrome.action.setTitle({
      tabId: job.tabId,
      title: "このページをJevWexで判定",
    });
    job.capture = await captureTab(job.tabId, { root: null, exclude: [] });
    const capture = job.capture;
    job.data = {
      jobId: job.id,
      url: capture.url,
      phase: "running",
      message: "判定条件を確認しています…",
      results: [],
    };
    await publish(job);
    signal.throwIfAborted();
    const rules = matchingRules(await readRules(), capture.url);
    if (!rules.length)
      throw new Error(
        "このURLでオンになっている判定条件がありません。パネルで条件を作成するかオンにしてください。",
      );
    const plans: {
      rule: (typeof rules)[number];
      inputs: ReturnType<typeof pageInputs>;
      error?: string;
    }[] = [];
    for (const rule of rules) {
      signal.throwIfAborted();
      try {
        const target = await captureTab(job.tabId, rule.contentScope);
        if (
          target.url !== capture.url ||
          (capture.documentId && target.documentId !== capture.documentId)
        )
          throw new InferenceUnavailable(
            "ページが移動しました。再実行してください。",
          );
        const inputs = pageInputs(target, "text");
        if (
          !inputs.length ||
          inputs.some((input) => !input.text.trim() && !input.images?.length)
        )
          throw new Error("この対象から文章・画像を取得できませんでした。");
        plans.push({ rule, inputs });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof InferenceUnavailable) throw error;
        plans.push({ rule, inputs: [], error: (error as Error).message });
      }
    }
    const manager = plans.some((plan) => plan.inputs.length)
      ? await client.discover(signal)
      : undefined;
    let failures = 0;
    const itemCount = plans.reduce(
      (sum, plan) => sum + plan.inputs.filter((input) => input.item).length,
      0,
    );
    for (const [index, plan] of plans.entries()) {
      signal.throwIfAborted();
      const { rule, inputs } = plan;
      if (plan.error) {
        failures++;
        job.data.results.push({
          name: rule.name,
          answers: [],
          error: plan.error,
        });
        await publish(job);
        continue;
      }
      const batch = !!inputs[0]?.item;
      for (const [itemIndex, input] of inputs.entries()) {
        signal.throwIfAborted();
        const before = (await readRules()).find(
          (saved) => saved.id === rule.id,
        );
        if (JSON.stringify(before) !== JSON.stringify(rule))
          throw new Error(
            "実行中に判定条件や対象が変更されました。再実行してください。",
          );
        job.data.message = `${batch ? `${itemIndex + 1} / ${inputs.length}件目 · ` : ""}${index + 1} / ${rules.length}条件：${rule.name} を判定中${input.truncated ? "（先頭48,000文字）" : ""}`;
        await publish(job);
        signal.throwIfAborted();
        let result: WebResult | undefined;
        let itemError: string | undefined;
        try {
          if (input.images?.length && manager?.supportsImages === false)
            throw new Error(
              "現在のモデルは画像を読み取れません。管理画面で画像対応モデルと画像用ファイルを読み込んでください。",
            );
          result = await client.evaluate(
            {
              requestId: crypto.randomUUID(),
              clientId: job.id,
              managerId: manager!.id,
              ruleId: rule.id,
              url: capture.url,
              text: input.text,
              ...(input.images?.length ? { images: input.images } : {}),
            },
            signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof InferenceUnavailable) throw error;
          itemError = (error as Error).message;
          failures++;
        }
        const current = (await readRules()).find(
          (saved) => saved.id === rule.id,
        );
        if (JSON.stringify(current) !== JSON.stringify(rule))
          throw new Error(
            "実行中に判定条件が変更されました。変更後の条件で再実行してください。",
          );
        signal.throwIfAborted();
        job.data.results.push({
          ...(result
            ? summarizeResult(rule.name, result)
            : { name: rule.name, answers: [], error: itemError }),
          ...(input.item ? { item: input.item } : {}),
          ...(input.target ? { target: input.target } : {}),
        });
        await publish(job);
      }
    }
    job.data.phase = "complete";
    job.data.message = `${itemCount ? `${itemCount}件を個別に、` : ""}${rules.length}件の条件で判定しました${failures ? `（失敗 ${failures}件）` : ""}${plans.some((plan) => plan.inputs.some((input) => input.truncated)) ? "（先頭48,000文字を使用）" : ""}。`;
    await publish(job);
  } catch (e) {
    const message = signal.aborted
      ? "判定を中止しました。"
      : (e as Error).message;
    if (job.data) {
      job.data.phase = signal.aborted ? "cancelled" : "error";
      job.data.message = message;
      await publish(job).catch(() => {});
    } else {
      await chrome.storage.session
        .set({
          [jobKey(job.tabId)]: { jobId: job.id, phase: "error", message },
        })
        .catch(() => {});
      await chrome.action
        .setBadgeText({ tabId: job.tabId, text: "!" })
        .catch(() => {});
      await chrome.action
        .setTitle({ tabId: job.tabId, title: message })
        .catch(() => {});
    }
  } finally {
    clearInterval(keepAlive);
    client.close();
    if (jobs.get(job.tabId) === job) jobs.delete(job.tabId);
  }
}
