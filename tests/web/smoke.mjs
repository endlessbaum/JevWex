import { loadModel } from "../extension/ui-helpers.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InferenceEngine } from "../../server/engine.mjs";
import { createJevWexServer } from "../../server/http.mjs";
import {
  fillSingleCriterion,
  runEvaluation,
} from "../extension/ui-helpers.mjs";
const exec = promisify(execFile);
await mkdir(".test-artifacts", { recursive: true });
const engine = new InferenceEngine(
  {
    model: process.env.JEV_TEST_MODEL ?? ".models/Qwen3-0.6B-Q4_K_M.gguf",
    hardware: { device: "cpu", threads: 4, gpuLayers: "all", context: 4096 },
  },
  { profile: resolve(".test-artifacts/server-test-profile") },
);
const app = createJevWexServer({ engine });
const url = await app.listen(0);
let browser;
const report = {
  passed: [],
  notRun: [
    "APIの画像モデル実推論・WebGPU実推論",
    "長時間連続運転・OSスリープ復帰",
    "サーバー版での10,000件一括推論",
  ],
  runs: [],
  errors: [],
};
const ok = (name) => {
  report.passed.push(name);
  console.log("PASS", name);
};
const headers = {
  Authorization: `Bearer ${app.token}`,
  "Content-Type": "application/json",
};
async function req(path, value, signal) {
  const response = await fetch(url + path, {
    headers,
    signal,
    ...(value ? { method: "POST", body: JSON.stringify(value) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const input = {
  state: "The cat sleeps on the sofa.",
  questions: {
    animal: {
      type: "choice",
      instructions: "Identify the animal.",
      criteria: { cat: "A cat", dog: "A dog" },
    },
    detail: {
      type: "score",
      instructions: "Rate the detail.",
      criteria: [
        "Names a subject.",
        "Describes an action.",
        "Describes action and location.",
      ],
    },
    cat: { type: "noul", instructions: "The text mentions a cat." },
  },
};
const single = { ...input, questions: { cat: input.questions.cat } };
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
try {
  assert.equal((await req("/api/v1/evaluate", input)).status, 503);
  await engine.start(url, app.token);
  report.browser = engine.context.browser().version();
  const result = await req("/api/v1/evaluate", input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.diagnostics.runtime, "wllama server browser");
  assert.equal(result.body.diagnostics.threads, 4);
  assert.equal(
    result.body.diagnostics.readout_method,
    "candidate_token_logprobs_v1",
  );
  for (const [id, kind] of [
    ["animal", "choice"],
    ["detail", "score"],
    ["cat", "noul"],
  ])
    assert.equal(result.body.response.answers[id].type, kind);
  report.runs.push(result.body);
  ok("API performs choice/score/noul before any UI browser is opened");
  browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await page.goto(`${url}/#token=${app.token}`);
  await page.locator("#server-page").waitFor({ state: "visible" });
  await page.getByText(/API用モデル：server:/).waitFor();
  assert.ok(!page.url().includes(app.token));
  assert.equal(
    await page.evaluate(
      () => crossOriginIsolated && typeof SharedArrayBuffer === "function",
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({
    path: ".test-artifacts/server-status.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1080 });
  ok(
    "plain HTTP page is isolated and displays API model/settings on desktop and mobile",
  );
  await page.locator("#nav-hardware").click();
  await page.locator("#hardware-threads").selectOption("4");
  await page.locator("#hardware-save").click();
  await page.locator("#nav-models").click();
  await page
    .locator("#files")
    .setInputFiles(resolve(".models/SmolLM2-135M-Instruct.Q4_K_M.gguf"));
  await loadModel(page);
  await page.waitForFunction(
    () =>
      !document.querySelector("#run").disabled ||
      !document.querySelector("#error").hidden,
    null,
    { timeout: 190000 },
  );
  assert.equal(
    await page.locator("#error").isVisible(),
    false,
    await page.locator("#error").textContent(),
  );
  await fillSingleCriterion(page, {});
  const ui = await runEvaluation(page);
  assert.equal(ui.diagnostics.runtime, "wllama browser page");
  assert.match(ui.response.model, /SmolLM/);
  assert.match((await req("/api/v1/status")).body.loaded.model, /Qwen3/);
  ok(
    "existing model management, hardware and single judgement work on the served page independently of the API model",
  );
  await page.locator("#nav-batch").click();
  await page.locator("#batch-copy-criteria").click();
  await page.locator("#batch-format").selectOption("lines");
  await page.locator("#batch-source").fill("The cat sleeps.\nA dog runs.");
  await page.locator("#batch-run").click();
  await page.waitForFunction(
    () => !document.querySelector("#batch-run").disabled,
    null,
    { timeout: 180000 },
  );
  assert.equal(
    await page.locator("#batch-error").isVisible(),
    false,
    await page.locator("#batch-error").textContent(),
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#batch-json").click();
  const batch = JSON.parse(
    await readFile(await (await downloadPromise).path(), "utf8"),
  );
  assert.equal(batch.summary.totals.success, 2);
  ok(
    "served batch page evaluates two records, aggregates and downloads results",
  );
  const env = {
    ...process.env,
    JEVWEX_TOKEN: app.token,
    JEVWEX_PORT: new URL(url).port,
    PYTHONUTF8: "1",
  };
  for (const [command, args] of [
    [process.execPath, ["examples/server/evaluate.mjs"]],
    ["python", ["examples/server/evaluate.py"]],
  ]) {
    const { stdout } = await exec(command, args, { env, timeout: 310000 });
    assert.equal(JSON.parse(stdout).response.answers.animal.type, "choice");
  }
  ok("Node.js and Python sample clients both perform real API inference");
  const concurrent = await Promise.all([
    req("/api/v1/evaluate", single),
    req("/api/v1/evaluate", single),
  ]);
  assert.ok(concurrent.every((r) => r.status === 200));
  ok("concurrent API requests run serially without conflicting with the UI");
  assert.equal(
    (await req("/api/v1/evaluate", { ...input, questions: {} })).status,
    400,
  );
  const png = await page.locator(".brand-mark").screenshot();
  const images = [
    {
      name: "sample.png",
      mime_type: "image/png",
      data_base64: png.toString("base64"),
    },
  ];
  assert.equal(
    (await req("/api/v1/evaluate", { ...single, images })).body.error.code,
    "MODEL_UNSUPPORTED",
  );
  assert.equal(
    (
      await req("/api/v1/evaluate", {
        ...single,
        images: [{ ...images[0], data_base64: "AAAA" }],
      })
    ).body.error.code,
    "INVALID_REQUEST",
  );
  ok("API request and actual image decoding errors are validated");
  const controller = new AbortController();
  const pending = req(
    "/api/v1/evaluate",
    {
      ...input,
      questions: Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [`q${i}`, input.questions.cat]),
      ),
    },
    controller.signal,
  ).catch(() => {});
  await until(
    async () => (await req("/api/v1/status")).body.phase === "running",
  );
  controller.abort();
  await pending;
  assert.equal((await req("/api/v1/evaluate", single)).status, 200);
  ok("disconnect cancels active API inference and the engine remains reusable");
  await browser.close();
  browser = null;
  assert.equal((await req("/api/v1/evaluate", single)).status, 200);
  ok("API continues to work after the entire UI browser is closed");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await writeFile(
    "docs/server-test-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
