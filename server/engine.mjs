import { chromium } from "playwright";
import { mkdir, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
export class InferenceEngine {
  status = {
    phase: "starting",
    loaded: null,
    detail: "推論環境を起動しています",
  };
  files = [];
  constructor(config, { profile = resolve(".cache/server-browser") } = {}) {
    this.config = config;
    this.profile = profile;
  }
  async prepare() {
    const model = this.config.model;
    if (typeof model !== "string" || !model.trim())
      throw new Error("modelを指定してください");
    const local = /\.gguf$/i.test(model) && !/^https:\/\//.test(model);
    if (local) {
      this.files = [
        model,
        ...(this.config.projector ? [this.config.projector] : []),
      ].map((p) => resolve(p));
      for (const path of this.files) {
        const info = await stat(path);
        if (!info.isFile() || !info.size || !/\.gguf$/i.test(path))
          throw new Error("空でないGGUFファイルを指定してください");
      }
    }
  }
  async start(url, token) {
    try {
      await this.prepare();
      await mkdir(this.profile, { recursive: true });
      this.context = await chromium.launchPersistentContext(this.profile, {
        channel: "chromium",
        headless: true,
      });
      if (this.closing) {
        await this.context.close();
        return;
      }
      this.page = await this.context.newPage();
      this.page.on("crash", () => {
        this.status = {
          phase: "error",
          loaded: null,
          detail: "推論プロセスが停止しました。サーバーを再起動してください",
        };
      });
      this.context.on("close", () => {
        this.status = {
          phase: "error",
          loaded: null,
          detail: "推論環境が終了しました",
        };
      });
      await this.page.exposeFunction("reportEngine", (status) => {
        this.status = status;
      });
      await this.page.goto(`${url}/engine.html`);
      await this.page.waitForFunction(() => !!window.engine);
      await this.page.evaluate(
        ({ config, token }) => window.engine.initialize(config, token),
        {
          config: {
            ...this.config,
            ...(this.files.length
              ? { localFiles: this.files.map((file) => basename(file)) }
              : {}),
          },
          token,
        },
      );
    } catch (error) {
      this.status = {
        phase: "error",
        loaded: null,
        detail: `${error.message}\nChromiumが未導入の場合は npx playwright install chromium を実行してください。`,
      };
      throw error;
    }
  }
  async evaluate(input, signal) {
    if (signal.aborted)
      return { error: { code: "CANCELLED", message: "中止しました" } };
    const cancel = () =>
      void this.page?.evaluate(() => window.engine.cancel()).catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.page.evaluate(
        (input) => window.engine.evaluate(input),
        input,
      );
      if (signal.aborted)
        return { error: { code: "CANCELLED", message: "中止しました" } };
      return result;
    } catch (error) {
      return { error: { code: "RUNTIME_UNAVAILABLE", message: error.message } };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  async close() {
    this.closing = true;
    await this.context?.close();
  }
}
