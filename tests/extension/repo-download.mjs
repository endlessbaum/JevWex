import { loadModel } from "./ui-helpers.mjs";
import { navigate, runEvaluation } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir(".test-artifacts", { recursive: true });
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"],
});
const report = {
  browser: context.browser().version(),
  input: "unsloth/Qwen3-0.6B-GGUF",
  passed: [],
  requests: [],
  notRun: [
    "Qwen3 real inference/accuracy (this test covers download and load)",
  ],
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const page = await context.newPage();
  page.on("request", (r) => report.requests.push(r.url().split("?")[0]));
  await page.goto(`chrome-extension://${id}/jev.html`);
  await navigate(page, "models");
  const ok = (name) => {
    report.passed.push(name);
    console.log("PASS", name);
  };
  await page.locator("#download-url").fill(report.input + " &#x20;");
  await page.locator("#download").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#download-resolved")
        .textContent.includes("Qwen3-0.6B-Q4_K_M.gguf") ||
      document
        .querySelector("#download-status")
        .textContent.includes("選べません"),
    null,
    { timeout: 30000 },
  );
  report.resolved = await page.locator("#download-resolved").textContent();
  assert.match(report.resolved, /Qwen3-0.6B-Q4_K_M\.gguf/);
  ok("short repo input resolves real public Q4_K_M and shows target");
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
    null,
    { timeout: 240000 },
  );
  assert.match(
    await page.locator("#download-status").textContent(),
    /保存完了/,
  );
  report.selected = await page
    .locator("#models > li")
    .last()
    .getAttribute("data-model-id");
  assert.match(
    report.selected,
    /unsloth\/Qwen3-0.6B-GGUF\/resolve\/main\/Qwen3-0.6B-Q4_K_M\.gguf/,
  );
  ok("actual repository model downloaded into cache");
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll("#models > li").length === 1,
  );
  await navigate(page, "models");
  await page.locator("#download-url").fill(report.input);
  const before = report.requests.length;
  await page.locator("#download").click();
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  assert.match(
    await page.locator("#download-status").textContent(),
    /保存完了/,
  );
  assert.equal(report.requests.length, before);
  ok("same repo resolves its cached Q4_K_M offline after reload");
  if (process.env.JEV_TEST_GPU_INFERENCE) {
    await navigate(page, "hardware");
    await page.waitForFunction(
      () => !document.querySelector("#hardware-save").disabled,
    );
    assert.equal(await page.locator("#gpu-option").isDisabled(), false);
    await page.locator("#hardware-device").selectOption("webgpu");
    await page.locator("#hardware-save").click();
    await navigate(page, "models");
  }
  await loadModel(page);
  await page.waitForFunction(
    () =>
      !document.querySelector("#run").disabled ||
      !document.querySelector("#error").hidden,
    null,
    { timeout: 120000 },
  );
  assert.equal(
    await page.locator("#error").isVisible(),
    false,
    await page.locator("#error").textContent(),
  );
  report.loaded = await page.locator("#loaded").textContent();
  ok("downloaded Qwen3 loads offline with metadata chat template");
  if (process.env.JEV_TEST_GPU_INFERENCE) {
    await navigate(page, "judge");
    const beforeInference = report.requests.length;
    report.result = await runEvaluation(page);
    assert.deepEqual(
      Object.values(report.result.response.answers).map((a) => a.type),
      ["choice", "noul", "score"],
    );
    assert.ok(report.result.diagnostics.hardware.gpu_layers_offloaded > 0);
    assert.equal(report.requests.length, beforeInference);
    report.notRun = [
      "semantic accuracy benchmark; low-VRAM GPU fallback; other GPU vendors",
    ];
    console.log(
      "QWEN3 GPU",
      report.result.diagnostics.evaluation_ms,
      JSON.stringify(report.result.diagnostics.hardware),
    );
    ok(
      "Qwen3 WebGPU mixed choice/noul/score inference and result download offline",
    );
  }
  await page.screenshot({
    path: ".test-artifacts/repo-download.png",
    fullPage: true,
  });
  assert.ok(
    report.requests
      .filter((u) => u.startsWith("https:"))
      .every((u) =>
        ["huggingface.co", "us.aws.cdn.hf.co"].includes(new URL(u).hostname),
      ),
  );
  ok("no additional distribution hosts or permissions needed");
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  await writeFile(
    ".test-artifacts/repo-download-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
