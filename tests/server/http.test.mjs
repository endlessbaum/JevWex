import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createJevWexServer } from "../../server/http.mjs";
const input = {
  state: "A cat.",
  questions: { cat: { type: "noul", instructions: "Mentions a cat." } },
};
async function setup(
  t,
  options = {},
  evaluate = async (input) => ({ result: { echoed: input } }),
) {
  const engine = {
    status: { phase: "ready", loaded: { model: "test", generation: 1 } },
    evaluate,
    close: async () => {},
  };
  const app = createJevWexServer({ engine, ...options });
  const url = await app.listen(0);
  t.after(() => app.close());
  const headers = {
    Authorization: `Bearer ${app.token}`,
    "Content-Type": "application/json",
  };
  async function req(path, value, extra = {}) {
    const response = await fetch(url + path, {
      headers,
      ...(value ? { method: "POST", body: JSON.stringify(value) } : {}),
      ...extra,
    });
    return { status: response.status, body: await response.json() };
  }
  return { app, url, headers, engine, req };
}
test("static allowlist, MIME and isolation headers; no source/config/model disclosure", async (t) => {
  const { url } = await setup(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(
    page.headers.get("cross-origin-embedder-policy"),
    "require-corp",
  );
  assert.match(await page.text(), /JevWex/);
  assert.equal(
    (await fetch(url + "/runtime/wllama.wasm", { method: "HEAD" })).headers.get(
      "content-type",
    ),
    "application/wasm",
  );
  for (const path of [
    "/package.json",
    "/server.config.json",
    "/.env",
    "/%2e%2e%2fpackage.json",
    "/manifest.json",
  ])
    assert.equal((await fetch(url + path)).status, 404);
  assert.equal((await fetch(url + "/engine/model/0")).status, 401);
});
test("authentication, Host and Origin restrictions", async (t) => {
  const { url, headers, req } = await setup(t);
  assert.equal((await fetch(url + "/api/v1/status")).status, 401);
  assert.equal(
    (
      await req("/api/v1/status", null, {
        headers: { ...headers, Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  const code = await new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { headers: { Host: "attacker.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(code, 403);
  assert.equal((await req("/api/v1/status")).body.loaded.model, "test");
});
test("loading state, invalid envelope and content type are explicit errors", async (t) => {
  const { req, engine, headers } = await setup(t);
  assert.equal(
    (await req("/api/v1/evaluate", { ...input, extra: true })).status,
    400,
  );
  assert.equal(
    (
      await req("/api/v1/evaluate", input, {
        headers: { ...headers, "Content-Type": "text/plain" },
      })
    ).status,
    415,
  );
  engine.status = { phase: "loading", loaded: null, detail: "loading" };
  assert.equal(
    (await req("/api/v1/evaluate", input)).body.error.code,
    "MODEL_NOT_LOADED",
  );
});
test("concurrent requests run in order with no overlapping inference", async (t) => {
  let running = 0;
  const seen = [];
  const { req } = await setup(t, {}, async (input) => {
    assert.equal(running++, 0);
    seen.push(input.state);
    await new Promise((r) => setTimeout(r, 25));
    running--;
    return { result: input };
  });
  const results = await Promise.all(
    ["one", "two", "three"].map((state) =>
      req("/api/v1/evaluate", { ...input, state }),
    ),
  );
  assert.deepEqual(seen, ["one", "two", "three"]);
  assert.ok(results.every((r) => r.status === 200 && r.body.model === "test"));
});
test("queue limit and timeout cancel inference before reusing the engine", async (t) => {
  let entered;
  const ready = new Promise((r) => (entered = r));
  let cancelled = false;
  const { req } = await setup(
    t,
    { maxPending: 1, timeoutMs: 100 },
    (_input, signal) =>
      new Promise((resolve) => {
        entered();
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve({ error: { code: "CANCELLED" } });
          },
          { once: true },
        );
      }),
  );
  const first = req("/api/v1/evaluate", input);
  await ready;
  assert.equal((await req("/api/v1/evaluate", input)).status, 429);
  assert.equal((await first).status, 504);
  assert.equal(cancelled, true);
});
test("client disconnection propagates cancellation; model errors are forwarded", async (t) => {
  let entered, aborted;
  const ready = new Promise((r) => (entered = r)),
    stopped = new Promise((r) => (aborted = r));
  const { req, engine, url, headers } = await setup(
    t,
    {},
    (_input, signal) =>
      new Promise((resolve) => {
        entered();
        signal.addEventListener(
          "abort",
          () => {
            aborted();
            resolve({ error: { code: "CANCELLED" } });
          },
          { once: true },
        );
      }),
  );
  const controller = new AbortController();
  const pending = fetch(url + "/api/v1/evaluate", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    signal: controller.signal,
  }).catch(() => {});
  await ready;
  controller.abort();
  await pending;
  await stopped;
  engine.evaluate = async () => ({
    error: { code: "MODEL_UNSUPPORTED", message: "images unsupported" },
  });
  assert.equal((await req("/api/v1/evaluate", input)).status, 422);
});
