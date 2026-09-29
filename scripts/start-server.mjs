import { fileURLToPath } from "node:url";
import { buildApp } from "./build.mjs";
import { createJevWexServer } from "../server/http.mjs";
import { InferenceEngine } from "../server/engine.mjs";
import { readFile } from "node:fs/promises";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
try {
  const port = Number(process.env.JEVWEX_PORT ?? 39281);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("JEVWEX_PORTは1024〜65535で指定してください");
  await buildApp(true);
  const config = await readFile("server.config.json", "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return { model: "unsloth/Qwen3-0.6B-GGUF" };
      throw error;
    });
  if (process.env.JEVWEX_MODEL) config.model = process.env.JEVWEX_MODEL;
  const engine = new InferenceEngine(config);
  const app = createJevWexServer({ engine, token: process.env.JEVWEX_TOKEN });
  const url = await app.listen(port);
  console.log(
    `JevWex Web + HTTP API\n画面を開く: ${url}/#token=${app.token}\nAPI: ${url}/api/v1/evaluate\nAPIトークン: ${app.token}\nAPI用モデル: ${config.model}\nモデルの準備後は画面を閉じてもAPIを使えます。初回のURLモデルはダウンロードします。終了: Ctrl+C`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void app.close());
  void engine
    .start(url, app.token)
    .catch((error) => console.error(`APIモデルの準備に失敗: ${error.message}`));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
