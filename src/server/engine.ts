import { ModelManager } from "@wllama/wllama";
import { ModelSession } from "../inference/model-session";
import { createRuntime } from "../inference/wllama-assets";
import { ModelDownload } from "../inference/model-download";
import {
  DEFAULT_HARDWARE,
  detectHardware,
  resolveHardware,
  type HardwareSettings,
} from "../inference/hardware";
import { asJevError } from "../features/jev/types";
import { decodeApiInput } from "./input";

declare global {
  interface Window {
    engine: typeof engine;
    reportEngine: (status: unknown) => Promise<void>;
  }
}
let detail = "初期化中",
  preparing = true;
let current: AbortController | undefined;
const session = new ModelSession(createRuntime, report);
function report() {
  void window
    .reportEngine({
      phase: preparing ? "loading" : session.phase,
      loaded: session.loaded,
      detail,
    })
    .catch(() => {});
}
const engine = {
  async initialize(
    config: {
      model: string;
      projector?: string;
      hardware?: HardwareSettings;
      localFiles?: string[];
    },
    token: string,
  ) {
    try {
      const settings = resolveHardware(
        config.hardware ?? DEFAULT_HARDWARE,
        await detectHardware(),
      );
      if (config.localFiles?.length) {
        detail = "ローカルモデルを読み込んでいます";
        report();
        const files: Blob[] = [];
        for (let i = 0; i < config.localFiles.length; i++) {
          const response = await fetch(`/engine/model/${i}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok)
            throw new Error("サーバーのモデルファイルを読み込めません");
          files.push(await response.blob());
        }
        session.register({
          id: `server:${config.localFiles.join(" + ")}`,
          label: config.localFiles.join(" + "),
          size: files.reduce((n, f) => n + f.size, 0),
          source: files,
        });
      } else {
        const download = new ModelDownload(
          new ModelManager({ allowOffline: true, parallelDownloads: 1 }),
        );
        const model = await download.download(
          config.model,
          ({ loaded, total }) => {
            detail = `API用モデルを準備中：${(loaded / 1048576).toFixed(1)} / ${total > 0 ? (total / 1048576).toFixed(1) : "?"} MiB`;
            report();
          },
          () => {},
          config.projector ?? "",
        );
        session.register({
          id: `cache:${model.url}`,
          label: config.model,
          size: model.size,
          source: model,
        });
      }
      detail = "API用モデルを初期化しています";
      report();
      await session.load(session.selected, settings);
      preparing = false;
      detail = "APIを利用できます";
      report();
    } catch (error) {
      preparing = false;
      detail = asJevError(error).message;
      report();
      throw error;
    }
  },
  async evaluate(value: unknown) {
    const controller = new AbortController();
    current = controller;
    try {
      const input = await decodeApiInput(value);
      controller.signal.throwIfAborted();
      const result = await session.evaluate(
        input.request,
        controller.signal,
        input.images,
      );
      result.diagnostics.runtime = "wllama server browser";
      return { result };
    } catch (error) {
      const problem = asJevError(error);
      return {
        error: {
          code: problem.code,
          message: problem.message,
          question: problem.question,
        },
      };
    } finally {
      if (current === controller) current = undefined;
    }
  },
  cancel() {
    current?.abort();
    return session.stop();
  },
};
window.engine = engine;
