import { ModelSession, type ModelEntry, type Runtime } from "./model-session";
import {
  JevError,
  type JevInput,
  type LocalEvaluation,
  type Snapshot,
} from "../features/jev/types";
import { validateRequest } from "../features/jev/validate";
import { validateImageFiles, type InputImage } from "../features/jev/images";
import type { ResolvedHardware } from "./hardware";
import {
  validateCloudSettings,
  validateProfileId,
  type CloudConnection,
} from "./cloud-settings";
import { evaluateCloud } from "./cloud-evaluate";

// The loaded local runtime stays available while a cloud provider is selected.
export class DecisionSession {
  readonly local: ModelSession;
  private connection?: CloudConnection;
  private cloudSnapshot: Snapshot | null = null;
  private generation = 0;
  private active?: {
    controller: AbortController;
    promise: Promise<LocalEvaluation>;
  };
  private stopping = false;
  constructor(
    factory: (onLog?: (text: string) => void) => Runtime,
    private notify: () => void = () => {},
    private fetcher: typeof fetch = globalThis.fetch,
    private cloudEvaluator: typeof evaluateCloud = evaluateCloud,
  ) {
    this.local = new ModelSession(factory, notify);
  }
  get cloud() {
    return this.connection
      ? {
          ...validateCloudSettings(this.connection),
          profileId: this.connection.profileId,
        }
      : undefined;
  }
  get models() {
    return this.local.models;
  }
  get selected() {
    return this.local.selected;
  }
  set selected(id: string) {
    this.local.selected = id;
  }
  get timeouts() {
    return this.local.timeouts;
  }
  set timeouts(value: ModelSession["timeouts"]) {
    this.local.timeouts = value;
  }
  get loaded() {
    return this.cloudSnapshot ?? this.local.loaded;
  }
  get phase(): ModelSession["phase"] {
    return this.active
      ? this.stopping
        ? "stopping"
        : "running"
      : this.cloudSnapshot
        ? "ready"
        : this.local.phase;
  }
  register(entry: ModelEntry) {
    this.local.register(entry);
  }
  useCloud(value: CloudConnection) {
    if (
      this.active ||
      ["loading", "running", "stopping"].includes(this.local.phase)
    )
      throw new JevError("BUSY", "処理中は接続先を変更できません。");
    const settings = validateCloudSettings(value);
    if (settings.fallback && !this.local.loaded)
      throw new JevError(
        "MODEL_NOT_LOADED",
        "フォールバック用のローカルモデルを先に読み込んでください。",
      );
    const profileId =
      value.profileId === undefined
        ? undefined
        : validateProfileId(value.profileId);
    this.connection = { ...settings, profileId, apiKey: value.apiKey.trim() };
    this.cloudSnapshot = {
      model: `cloud:${settings.provider}:${profileId ?? settings.model}`,
      generation: --this.generation,
      load_ms: 0,
      threads: 0,
      context: 0,
      supports_images:
        this.local.loaded?.supports_images === true && settings.fallback,
    };
    this.notify();
  }
  useLocal() {
    if (this.active)
      throw new JevError("BUSY", "判定中は接続先を変更できません。");
    this.connection = undefined;
    this.cloudSnapshot = null;
    this.notify();
  }
  async load(id = this.selected, settings?: ResolvedHardware) {
    await this.stop();
    this.useLocal();
    return this.local.load(id, settings);
  }
  async unload() {
    await this.stop();
    this.useLocal();
    return this.local.unload();
  }
  resolveModel(input: JevInput) {
    if (!this.cloudSnapshot) return this.local.resolveModel(input);
    if (input.model && input.model !== this.cloudSnapshot.model)
      throw new JevError(
        "INVALID_REQUEST",
        "入力modelと選択中のクラウドモデルが一致しません。",
      );
    return this.cloudSnapshot.model;
  }
  evaluate(
    input: JevInput,
    signal?: AbortSignal,
    images: readonly InputImage[] = [],
  ): Promise<LocalEvaluation> {
    if (this.active) return Promise.reject(new JevError("BUSY", "実行中です"));
    if (!this.connection || !this.cloudSnapshot)
      return this.local.evaluate(input, signal, images);
    const request = structuredClone(validateRequest(input));
    this.resolveModel(request);
    validateImageFiles(images);
    const imageSnapshot = structuredClone(images);
    const config = { ...this.connection },
      snapshot = { ...this.cloudSnapshot };
    const controller = new AbortController(),
      start = performance.now();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const promise = (async () => {
      let reason: string;
      try {
        controller.signal.throwIfAborted();
        if (imageSnapshot.length)
          throw new JevError(
            "MODEL_UNSUPPORTED",
            "クラウド接続は文章専用です。画像を含む判定にはローカルモデルを利用してください。",
          );
        return await this.cloudEvaluator(
          config,
          request,
          snapshot,
          controller.signal,
          this.fetcher,
        );
      } catch (error) {
        if (controller.signal.aborted)
          throw new JevError("CANCELLED", "中止しました");
        if (!config.fallback) throw error;
        reason =
          error instanceof JevError
            ? error.message
            : "クラウドAPIでエラーが発生しました。";
      }
      if (!this.local.loaded)
        throw new JevError(
          "MODEL_NOT_LOADED",
          "クラウドAPIの利用に失敗し、フォールバック用のローカルモデルも未準備です。",
        );
      const localInput = { ...request, model: this.local.loaded.model };
      const result = await this.local.evaluate(
        localInput,
        controller.signal,
        imageSnapshot,
      );
      result.diagnostics.provider = "local";
      result.diagnostics.fallback = { from: config.provider, reason };
      result.diagnostics.evaluation_ms = performance.now() - start;
      result.diagnostics.warnings.unshift(
        `ローカルモデルで判定しました：${reason}`,
      );
      return result;
    })()
      .then((result) => {
        if (controller.signal.aborted)
          throw new JevError("CANCELLED", "中止しました");
        return result;
      })
      .finally(() => {
        signal?.removeEventListener("abort", abort);
        this.active = undefined;
        this.stopping = false;
        this.notify();
      });
    this.active = { controller, promise };
    this.notify();
    return promise;
  }
  async stop() {
    if (this.active) {
      this.stopping = true;
      this.active.controller.abort();
      this.notify();
      await this.active.promise.catch(() => {});
    }
    await this.local.stop();
  }
  dispose() {
    this.active?.controller.abort();
    this.connection = undefined;
    this.local.dispose();
  }
}
