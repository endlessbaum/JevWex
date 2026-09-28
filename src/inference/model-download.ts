import {
  ModelValidationStatus,
  getHFModelSource,
  type Model,
  type ModelManager,
  type DownloadOptions,
} from "@wllama/wllama";
import { JevError } from "../features/jev/types";

export const MODEL_DOWNLOAD_ORIGINS = [
  "https://huggingface.co",
  "https://us.aws.cdn.hf.co",
] as const;
// A UI convenience only; neither the session nor the evaluator fixes a model.
export const EXAMPLE_MODEL_URL =
  "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf";
export const DEFAULT_REPO_QUANT = "Q4_K_M";
export function modelDownloadInput(
  text: string,
): { repo: string } | { url: string } {
  // Also tolerate a trailing HTML space entity copied from a rendered message.
  const input = text.replace(/(?:\s|&(?:#x20|#32|nbsp);)+$/gi, "").trim();
  if (
    /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(input)
  ) {
    return { repo: input };
  }
  return { url: modelDownloadUrl(input) };
}
export function modelDownloadUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new JevError(
      "INVALID_REQUEST",
      "Hugging Faceのリポジトリ名（所有者/モデル）またはHTTPSのGGUF直接URLを入力してください",
    );
  }
  if (
    url.origin !== MODEL_DOWNLOAD_ORIGINS[0] ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/[^/]+\/[^/]+\/resolve\/[^/]+\/.+\.gguf$/.test(url.pathname) ||
    [...url.searchParams].some(([k, v]) => k !== "download" || v !== "true")
  ) {
    throw new JevError(
      "INVALID_REQUEST",
      "huggingface.co の公開GGUF直接URL（https://huggingface.co/所有者/モデル/resolve/リビジョン/ファイル.gguf）を指定してください。認証付きURLは未対応です。",
    );
  }
  if (/-\d{5}-of-\d{5}\.gguf$/.test(url.pathname))
    throw new JevError(
      "INVALID_REQUEST",
      "URLダウンロードは単一GGUFに対応しています。分割モデルは全パートをローカルファイルから選択してください。",
    );
  url.search = ""; // The optional download=true does not change model identity.
  return url.href;
}
type DownloadManager = Pick<
  ModelManager,
  "getModels" | "downloadModel" | "cacheManager"
>;
export class ModelDownload {
  private active?: AbortController;
  constructor(
    private manager: DownloadManager,
    private resolveRepo = getHFModelSource,
  ) {}
  get busy() {
    return !!this.active;
  }
  cancel() {
    this.active?.abort();
  }
  async download(
    text: string,
    progress: NonNullable<DownloadOptions["progressCallback"]>,
    resolved: (url: string, mmprojUrl?: string) => void = () => {},
    projector = "",
  ): Promise<Model> {
    if (this.active) throw new JevError("BUSY", "ダウンロード中です");
    const explicitProjector = projector.trim()
      ? modelDownloadUrl(projector)
      : undefined;
    const input = modelDownloadInput(text),
      controller = new AbortController();
    this.active = controller;
    let started = false;
    let mmprojUrl = explicitProjector;
    const preserved = new Set<string>();
    let url = "url" in input ? input.url : "";
    try {
      const models = await this.manager.getModels();
      controller.signal.throwIfAborted();
      for (const model of models) {
        preserved.add(model.url);
        if (model.mmprojUrl) preserved.add(model.mmprojUrl);
      }
      if ("repo" in input) {
        const prefix = `https://huggingface.co/${input.repo}/resolve/main/`;
        const candidates = models.filter(
          (m) =>
            m.url.startsWith(prefix) &&
            /(?:[-_.])Q4_K_M\.gguf$/i.test(new URL(m.url).pathname),
        );
        if (candidates.length === 1) {
          url = modelDownloadUrl(candidates[0].url);
          mmprojUrl = explicitProjector ?? candidates[0].mmprojUrl;
        } else {
          try {
            const source = await this.resolveRepo({
              repo: input.repo,
              quant: DEFAULT_REPO_QUANT,
              mmprojQuant: "", // Public helper: select an available projector, if present.
            });
            controller.signal.throwIfAborted();
            url = modelDownloadUrl(source.url);
            mmprojUrl =
              explicitProjector ??
              (source.mmprojUrl
                ? modelDownloadUrl(source.mmprojUrl)
                : undefined);
          } catch (error) {
            if (controller.signal.aborted) throw error;
            throw new JevError(
              "DOWNLOAD_FAILED",
              `リポジトリから単一の${DEFAULT_REPO_QUANT} GGUFを選べませんでした。公開リポジトリ名を確認するか、取得したいGGUFの直接URLを入力してください: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      controller.signal.throwIfAborted();
      resolved(url, mmprojUrl);
      const cached = models.find(
        (m) => m.url === url && (!mmprojUrl || m.mmprojUrl === mmprojUrl),
      );
      controller.signal.throwIfAborted();
      if (cached) {
        progress({ loaded: cached.size, total: cached.size });
        return cached;
      }
      started = true;
      const model = await this.manager.downloadModel(
        mmprojUrl ? { url, mmprojUrl } : url,
        {
          signal: controller.signal,
          progressCallback: (p) => {
            if (!controller.signal.aborted) progress(p);
          },
        },
      );
      controller.signal.throwIfAborted();
      if (model.validate() !== ModelValidationStatus.VALID)
        throw new JevError(
          "DOWNLOAD_FAILED",
          "ダウンロードサイズを確認できません。完了したモデルとして登録しません。",
        );
      return model;
    } catch (error) {
      // The public cache API deletes newly downloaded files and their metadata.
      // Await completion/cancellation before cleanup so no writer is still active.
      if (started) {
        for (const target of [url, mmprojUrl])
          if (target && !preserved.has(target))
            await this.manager.cacheManager.delete(target).catch(() => {});
      }
      if (controller.signal.aborted)
        throw new JevError("CANCELLED", "モデルのダウンロードを中止しました");
      if (error instanceof JevError) throw error;
      throw new JevError(
        "DOWNLOAD_FAILED",
        `モデルを取得できませんでした。公開URL、ネットワーク、保存容量、許可配信元を確認してください: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.active = undefined;
    }
  }
}
