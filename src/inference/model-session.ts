import type { Wllama, Model } from "@wllama/wllama";
import { evaluate, type ChatRuntime } from "../features/jev/evaluate";
import {
  JevError,
  asJevError,
  type JevInput,
  type LocalEvaluation,
  type Snapshot,
} from "../features/jev/types";
import { validateRequest } from "../features/jev/validate";
import {
  DEFAULT_LOAD,
  sameHardware,
  projectorOffload,
  type ResolvedHardware,
} from "./hardware";
import { validateImageFiles, type InputImage } from "../features/jev/images";
import { readAnswerTokens, type AnswerToken } from "./answer-tokens";
export interface ModelEntry {
  id: string;
  label: string;
  size: number;
  source: Blob[] | Model;
}
export type Runtime = Pick<
  Wllama,
  "loadModel" | "exit" | "getChatTemplate" | "getNumThreads"
> &
  ChatRuntime & {
    getLoadedContextInfo(): { n_ctx: number; has_image_input?: boolean };
  };
export class ModelSession {
  // Settings are snapshotted at the start of each operation.
  timeouts = { loadSeconds: 180, responseSeconds: 0 };
  readonly models = new Map<string, ModelEntry>();
  selected = "";
  loaded: Snapshot | null = null;
  phase: "empty" | "loading" | "ready" | "running" | "stopping" | "error" =
    "empty";
  private answerTokens: AnswerToken[] = [];
  private runtime: Runtime | null = null;
  private loadedEntry: ModelEntry | null = null;
  private generation = 0;
  private transition = false;
  private current?: {
    controller: AbortController;
    promise: Promise<LocalEvaluation>;
  };
  constructor(
    private factory: (onLog?: (text: string) => void) => Runtime,
    private notify: () => void = () => {},
  ) {}
  register(entry: ModelEntry) {
    this.models.set(entry.id, entry);
    this.selected = entry.id;
    this.notify();
  }
  resolveModel(request: JevInput): string {
    const id = request.model ?? this.loaded?.model;
    if (!id)
      throw new JevError("MODEL_NOT_LOADED", "モデルを読み込んでください");
    if (!this.models.has(id))
      throw new JevError("INVALID_REQUEST", `未登録のローカルモデルID: ${id}`);
    if (id !== this.loaded?.model)
      throw new JevError(
        "MODEL_NOT_LOADED",
        `model ${id} は未読込です。選択して読み込んでください`,
      );
    return id;
  }
  async load(
    id = this.selected,
    settings: ResolvedHardware = DEFAULT_LOAD,
  ): Promise<void> {
    if (this.transition) throw new JevError("BUSY", "モデル操作中です");
    const entry = this.models.get(id);
    if (!entry)
      throw new JevError("INVALID_REQUEST", "登録済みモデルを選択してください");
    const requested = { ...settings };
    const loadSeconds = this.timeouts.loadSeconds;
    const loadErrors: string[] = [];
    const loadFailure = (message: string) =>
      new JevError("LOAD_FAILED", [message, ...loadErrors].join("\n"));
    this.transition = true;
    try {
      await this.stop();
      if (
        this.loaded?.model === id &&
        this.loadedEntry === entry &&
        this.loaded.hardware &&
        sameHardware(this.loaded.hardware.requested, requested)
      )
        return;
      await this.release();
      this.phase = "loading";
      this.notify();
      let offloaded: number | null = requested.device === "cpu" ? 0 : null;
      const start = performance.now(),
        runtime = this.factory((text) => {
          // Observe the public logger; do not query private bindings or infer GPU use from the requested setting.
          const match = text.match(
            /offloaded\s+(\d+)\/\d+\s+layers?\s+to GPU/i,
          );
          if (match) offloaded = Number(match[1]);
          for (const line of text.split(/\r?\n/)) {
            if (
              /error|fail(?:ed|ure)?|out of memory|unsupported|cannot|could not/i.test(
                line,
              )
            ) {
              loadErrors.push(line.slice(0, 600));
              if (loadErrors.length > 8) loadErrors.shift();
            }
          }
        });
      this.runtime = runtime;
      // ctx_shift=false: oversized input must fail, never silently discard state.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          runtime.loadModel(entry.source, {
            n_ctx: requested.context,
            n_threads: requested.threads,
            n_gpu_layers: requested.gpuLayers,
            mmproj_offload: projectorOffload(requested),
            n_parallel: 1,
            ctx_shift: false,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new JevError(
                    "RUNTIME_UNAVAILABLE",
                    `モデル初期化が${loadSeconds}秒以内に完了しませんでした。ハードウェア設定で読み込みの待ち時間を延ばせます。`,
                  ),
                ),
              loadSeconds * 1000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const contextInfo = runtime.getLoadedContextInfo();
      // Wllama 3.6.1 can resolve loadModel after native initialization fails.
      // Its empty context then has no template either; diagnose the load first.
      if (!Number.isSafeInteger(contextInfo.n_ctx) || contextInfo.n_ctx <= 0)
        throw loadFailure(
          "モデルの初期化に失敗しました。次の読み込みログを確認してください。",
        );
      if (!runtime.getChatTemplate())
        throw new JevError(
          "MODEL_UNSUPPORTED",
          "GGUFにチャットテンプレートがありません",
        );
      this.answerTokens = await readAnswerTokens(
        Array.isArray(entry.source) ? entry.source : await entry.source.open(),
      );
      this.loaded = {
        model: id,
        generation: ++this.generation,
        load_ms: performance.now() - start,
        threads: runtime.getNumThreads(),
        context: contextInfo.n_ctx,
        supports_images: contextInfo.has_image_input === true,
        hardware: { requested, gpu_layers_offloaded: offloaded },
      };
      this.loadedEntry = entry;
      this.phase = "ready";
    } catch (error) {
      await this.release();
      this.phase = "error";
      if (error instanceof JevError) throw error;
      throw loadFailure(error instanceof Error ? error.message : String(error));
    } finally {
      this.transition = false;
      this.notify();
    }
  }
  async unload() {
    if (this.transition) throw new JevError("BUSY", "モデル操作中です");
    this.transition = true;
    try {
      await this.stop();
      await this.release();
      this.phase = "empty";
    } finally {
      this.transition = false;
      this.notify();
    }
  }
  private async release() {
    const runtime = this.runtime;
    this.runtime = null;
    this.loaded = null;
    this.loadedEntry = null;
    this.answerTokens = [];
    this.generation++;
    await runtime?.exit();
  }
  evaluate(
    input: JevInput,
    signal?: AbortSignal,
    images: readonly InputImage[] = [],
  ): Promise<LocalEvaluation> {
    if (this.transition || this.current)
      return Promise.reject(new JevError("BUSY", "実行中です"));
    const request = validateRequest(input);
    this.resolveModel(request);
    if (!this.runtime || !this.loaded)
      return Promise.reject(new JevError("MODEL_NOT_LOADED", "モデル未読込"));
    validateImageFiles(images);
    if (images.length && !this.loaded.supports_images)
      return Promise.reject(
        new JevError(
          "MODEL_UNSUPPORTED",
          "現在のモデルは画像を読み取れません。画像対応モデルと、そのモデル用の画像用ファイルを一緒に読み込んでください。",
        ),
      );
    const imageSnapshot = structuredClone(images);
    const snapshot = { ...this.loaded },
      controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const responseSeconds = this.timeouts.responseSeconds;
    let timedOut = false;
    const timer =
      responseSeconds > 0
        ? setTimeout(() => {
            if (!controller.signal.aborted) {
              timedOut = true;
              controller.abort();
            }
          }, responseSeconds * 1000)
        : undefined;
    this.phase = "running";
    const promise = evaluate(
      this.runtime,
      request,
      snapshot,
      this.answerTokens,
      controller.signal,
      imageSnapshot,
    )
      .then((result) => {
        if (
          controller.signal.aborted ||
          snapshot.generation !== this.loaded?.generation
        )
          throw new JevError("CANCELLED", "古い実行結果を破棄しました");
        return result;
      })
      .catch((e) => {
        if (timedOut)
          throw new JevError(
            "TIMEOUT",
            `判定が${responseSeconds}秒以内に完了しませんでした。ハードウェア設定で応答の待ち時間を延ばせます。`,
          );
        throw asJevError(e);
      })
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.current = undefined;
        this.phase = this.loaded ? "ready" : "empty";
        this.notify();
      });
    this.current = { controller, promise };
    this.notify();
    return promise;
  }
  async stop() {
    const active = this.current;
    if (active) {
      this.phase = "stopping";
      this.notify();
      active.controller.abort();
      // Await public API cancellation acknowledgement before unloading or switching.
      await active.promise.catch(() => {});
    }
  }
  dispose() {
    // Page-owned dedicated workers die with the document. exit() is best effort;
    // correctness never relies on awaiting a pagehide callback.
    this.current?.controller.abort();
    void this.runtime?.exit();
  }
}
