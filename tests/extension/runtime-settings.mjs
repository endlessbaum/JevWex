import { loadModel, modelRow } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { navigate, fillSingleCriterion, runEvaluation } from "./ui-helpers.mjs";

await mkdir(".test-artifacts", { recursive: true });
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"],
});
const report = { passed: [], errors: [] };
const ok = (text) => {
  report.passed.push(text);
  console.log("PASS", text);
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(String(error)));
  await page.goto(`chrome-extension://${id}/jev.html#models`);
  await context.setOffline(true);
  // Seed real cached files via the public cache API, without network transfers.
  const seed = await build({
    stdin: {
      contents: `import { CacheManager } from '@wllama/wllama'; globalThis.seedStartupModel = async (url) => {
      const file = document.querySelector('#files').files[0];
      const cache = new CacheManager();
      await cache.write(await cache.getNameFromURL(url), file.stream(), { originalURL: url, originalSize: file.size, etag: 'local-fixture' });
    };`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
  });
  await page.evaluate(seed.outputFiles[0].text);
  const small =
    "cache:https://huggingface.co/test/startup/resolve/main/small.gguf";
  const large =
    "cache:https://huggingface.co/test/startup/resolve/main/large.gguf";
  for (const [key, file] of [
    [small, ".models/SmolLM2-135M-Instruct.Q4_K_M.gguf"],
    [large, ".models/Qwen3-0.6B-Q4_K_M.gguf"],
  ]) {
    await page.locator("#files").setInputFiles(resolve(file));
    await page.evaluate(
      (url) => globalThis.seedStartupModel(url),
      key.slice(6),
    );
  }
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("#runtime-fallback").options.length === 3,
  );
  await navigate(page, "hardware");
  await page.locator("#runtime-max-size").fill("0.2");
  await page.locator("#runtime-fallback").selectOption(small);
  await page.locator("#runtime-load-seconds").fill("900");
  await page.locator("#runtime-response-seconds").fill("1800");
  await page.locator("#runtime-save").click();
  await page.evaluate(
    (large) =>
      localStorage.setItem(
        "jev.last-model.v1",
        JSON.stringify({ id: large, label: "large" }),
      ),
    large,
  );
  await page.reload();
  await page.waitForFunction(
    () => !document.querySelector("#run").disabled,
    null,
    { timeout: 120000 },
  );
  assert.match(
    await page.locator("#startup-status").textContent(),
    /スキップ.*small/,
  );
  assert.match(await page.locator("#judge-model").textContent(), /small/);
  assert.equal(
    await page.locator("#runtime-response-seconds").inputValue(),
    "1800",
  );
  assert.equal(await page.locator("#runtime-load-seconds").inputValue(), "900");
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("jev.last-model.v1")).id,
    ),
    large,
  );
  ok(
    "saved timeout preferences survive reload; oversized last model falls back to real cached small model without overwriting last selection",
  );
  const advertised = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const channel = new BroadcastChannel("jev-web-page-judge-v1");
        channel.onmessage = ({ data }) => {
          if (data.type === "status") {
            channel.close();
            resolve(data.status.responseSeconds);
          }
        };
        channel.postMessage({ type: "hello" });
      }),
  );
  assert.equal(advertised, 1800);
  ok("shortcut and page judge receive the configured response deadline");
  await navigate(page, "judge");
  await fillSingleCriterion(page);
  await runEvaluation(page);
  ok("fallback model performs real inference offline");
  await navigate(page, "hardware");
  await page.locator("#runtime-fallback").selectOption(large);
  await page.locator("#runtime-save").click();
  await page.reload();
  await page.waitForFunction(() =>
    document
      .querySelector("#startup-status")
      .textContent.includes("条件に合う代替モデルがない"),
  );
  assert.equal(await page.locator("#run").isDisabled(), true);
  ok("oversized explicit fallback leaves startup unloaded");
  await page.locator("#runtime-startup").selectOption("none");
  await page.locator("#runtime-save").click();
  await page.reload();
  await page.waitForFunction(() =>
    document
      .querySelector("#startup-status")
      .textContent.includes("自動読み込みはオフ"),
  );
  assert.equal(await page.locator("#run").isDisabled(), true);
  ok("disabled automatic loading remains disabled across reloads");
  await navigate(page, "models");
  await loadModel(page, large);
  await page.waitForFunction(
    () => !document.querySelector("#run").disabled,
    null,
    { timeout: 120000 },
  );
  assert.match(await page.locator("#judge-model").textContent(), /large/);
  ok("manual load remains available above the automatic size limit");
  assert.equal(
    await modelRow(page, large).locator(".model-state").textContent(),
    "使用中",
  );
  assert.equal(
    await modelRow(page, small).locator(".model-state").textContent(),
    "未使用",
  );
  await page
    .locator("#files")
    .setInputFiles(resolve(".models/SmolLM2-135M-Instruct.Q4_K_M.gguf"));
  assert.equal(await page.locator("#models > li").count(), 3);
  assert.equal(await modelRow(page, large).getAttribute("data-active"), "true");
  await page.setViewportSize({ width: 480, height: 1000 });
  await page
    .locator('[aria-labelledby="model-heading"]')
    .screenshot({ path: ".test-artifacts/model-list.png" });
  const local = await modelRow(page).getAttribute("data-model-id");
  page.once("dialog", (dialog) => dialog.accept());
  await modelRow(page, small).locator('[data-model-action="remove"]').click();
  await modelRow(page, small).waitFor({ state: "detached" });
  assert.equal(await modelRow(page, large).getAttribute("data-active"), "true");
  assert.equal(await page.locator("#run").isDisabled(), false);
  await loadModel(page, local);
  await page.waitForFunction(() => !document.querySelector("#run").disabled);
  assert.equal(
    await modelRow(page, large).locator(".model-state").textContent(),
    "未使用",
  );
  assert.equal(
    await modelRow(page, local).locator(".model-state").textContent(),
    "使用中",
  );
  await modelRow(page, local).locator('[data-model-action="unload"]').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#models > li[data-active="true"]').length ===
      0,
  );
  ok(
    "all models are visible; row-specific deletion preserves the active model and load/unload updates the current-model badge",
  );
  await navigate(page, "hardware");
  await page.setViewportSize({ width: 480, height: 1000 });
  await page
    .locator('[aria-labelledby="runtime-settings-heading"]')
    .screenshot({ path: ".test-artifacts/runtime-settings.png" });
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(
    ".test-artifacts/runtime-settings-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
