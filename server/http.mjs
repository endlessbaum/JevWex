import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
const failure = (code, message) => ({ error: { code, message } });
const errorStatus = (code) =>
  ({
    INVALID_REQUEST: 400,
    MODEL_NOT_LOADED: 503,
    MODEL_UNSUPPORTED: 422,
    CONTEXT_LIMIT: 422,
    INVALID_OUTPUT: 422,
    BUSY: 409,
    CANCELLED: 409,
  })[code] ?? 500;
const assets = new Set([
  "/index.html",
  "/jev.html",
  "/page.js",
  "/page.js.map",
  "/page.css",
  "/page.css.map",
  "/engine.html",
  "/engine.js",
  "/engine.js.map",
  "/runtime/wllama.wasm",
  "/runtime/WLLAMA-LICENSE.txt",
  "/LICENSE",
  "/THIRD_PARTY_NOTICES.md",
  "/licenses/WASM-UPSTREAM-NOTICES.txt",
  "/licenses/EMDAWNWEBGPU-NOTICES.txt",
  "/licenses/LLVM-RUNTIME-NOTICES.txt",
]);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".wasm": "application/wasm",
};
export function createJevWexServer({
  engine,
  root = fileURLToPath(new URL("../dist-web/", import.meta.url)),
  token = randomBytes(32).toString("hex"),
  timeoutMs = 300000,
  maxPending = 8,
} = {}) {
  if (!engine) throw new Error("推論エンジンが必要です");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token))
    throw new Error("JEVWEX_TOKENは英数字・_・-の32〜128文字です");
  const secret = Buffer.from(`Bearer ${token}`),
    jobs = new Set();
  let active = null,
    bytes = 0,
    closing = false;
  function json(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  }
  function finish(job, status, value) {
    if (!jobs.delete(job)) return;
    clearTimeout(job.timer);
    bytes -= job.bytes;
    json(job.res, status, value);
  }
  function cancel(job, status, code, message) {
    job.controller.abort();
    finish(job, status, failure(code, message));
  }
  async function run() {
    if (active || closing) return;
    const job = jobs.values().next().value;
    if (!job) return;
    active = job;
    try {
      const output = await engine.evaluate(job.input, job.controller.signal);
      finish(
        job,
        output.error ? errorStatus(output.error.code) : 200,
        output.error ? { error: output.error } : output.result,
      );
    } catch (error) {
      finish(job, 500, failure("RUNTIME_UNAVAILABLE", error.message));
    } finally {
      active = null;
      void run();
    }
  }
  async function readBody(req) {
    if (
      !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
    )
      throw Object.assign(
        new Error("Content-Type: application/json が必要です"),
        { status: 415 },
      );
    const limit = 56 * 1048576;
    if (Number(req.headers["content-length"]) > limit)
      throw Object.assign(new Error("本文は56 MiBまでです"), { status: 413 });
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit)
        throw Object.assign(new Error("本文は56 MiBまでです"), { status: 413 });
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("本文はオブジェクトで指定してください");
    return { value, size };
  }
  async function file(res, req, path, type) {
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink())
      return json(res, 404, failure("NOT_FOUND", "ファイルがありません"));
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size });
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(path);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }
  const server = createServer(async (req, res) => {
    for (const [key, value] of Object.entries({
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    }))
      res.setHeader(key, value);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://huggingface.co https://us.aws.cdn.hf.co; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (
        req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== `http://${host}`)
      )
        return json(
          res,
          403,
          failure("FORBIDDEN", "HostまたはOriginが一致しません"),
        );
      const path = req.url?.split("?")[0];
      if (!path?.startsWith("/api/") && !path?.startsWith("/engine/model/")) {
        const asset = path === "/" ? "/index.html" : path;
        if (!["GET", "HEAD"].includes(req.method) || !assets.has(asset))
          return json(res, 404, failure("NOT_FOUND", "ファイルがありません"));
        return await file(
          res,
          req,
          resolve(root, asset.slice(1)),
          mime[extname(asset)] ?? "text/plain; charset=utf-8",
        );
      }
      const supplied = Buffer.from(req.headers.authorization ?? "");
      if (
        supplied.length !== secret.length ||
        !timingSafeEqual(supplied, secret)
      )
        return json(res, 401, failure("UNAUTHORIZED", "APIトークンが違います"));
      if (req.method === "GET" && /^\/engine\/model\/\d+$/.test(path)) {
        const model = engine.files?.[Number(path.split("/").at(-1))];
        if (!model)
          return json(
            res,
            404,
            failure("NOT_FOUND", "モデルファイルがありません"),
          );
        return await file(res, req, model, "application/octet-stream");
      }
      if (req.method === "GET" && path === "/api/v1/status")
        return json(res, 200, { ...engine.status, pending: jobs.size });
      if (req.method !== "POST" || path !== "/api/v1/evaluate")
        return json(res, 404, failure("NOT_FOUND", "未対応の操作です"));
      const { value, size } = await readBody(req);
      if (
        !Object.hasOwn(value, "state") ||
        !Object.hasOwn(value, "questions") ||
        Object.keys(value).some(
          (key) => !["state", "questions", "model", "images"].includes(key),
        )
      )
        return json(
          res,
          400,
          failure(
            "INVALID_REQUEST",
            "state・questionsと、任意のmodel・imagesを指定してください",
          ),
        );
      if (
        !engine.status.loaded ||
        !["ready", "running", "stopping"].includes(engine.status.phase)
      )
        return json(
          res,
          503,
          failure("MODEL_NOT_LOADED", engine.status.detail),
        );
      if (jobs.size >= maxPending || bytes + size > 64 * 1048576)
        return json(res, 429, failure("QUEUE_FULL", "待ち行列が満杯です"));
      const job = {
        input: { ...value, model: value.model ?? engine.status.loaded.model },
        bytes: size,
        res,
        controller: new AbortController(),
      };
      jobs.add(job);
      bytes += size;
      job.timer = setTimeout(
        () => cancel(job, 504, "TIMEOUT", "待機を含む判定期限を超えました"),
        timeoutMs,
      );
      res.on("close", () => {
        if (!res.writableEnded)
          cancel(job, 499, "CANCELLED", "呼び出し元が切断しました");
      });
      void run();
    } catch (error) {
      if (res.headersSent) res.destroy();
      else
        json(
          res,
          error.status ?? 400,
          failure("INVALID_REQUEST", error.message),
        );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return {
    server,
    token,
    async listen(port = 39281) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      closing = true;
      for (const job of [...jobs])
        cancel(job, 503, "SERVER_STOPPED", "サーバーを終了しました");
      const done = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await engine.close();
      await done;
    },
  };
}
