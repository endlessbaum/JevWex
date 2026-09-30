import { loadModel, modelRow } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { navigate } from "./ui-helpers.mjs";
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
  const helpers = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { CacheManager } from '@wllama/wllama';
    globalThis.seedDeletionModel = async ({ url, projector, local }) => {
      const file = local ? document.querySelector('#files').files[0] : new Blob([new Uint8Array(32)]);
      const cache = new CacheManager();
      await cache.write(await cache.getNameFromURL(url), file.stream(), { originalURL: url, originalSize: file.size, etag: 'fixture', mmprojURL: projector });
    };
    globalThis.deletionFiles = async () => (await new CacheManager().list()).map(file => file.metadata.originalURL);
  `,
    },
    bundle: true,
    write: false,
    format: "iife",
  });
  const prefix = "https://huggingface.co/test/removal/resolve/main/";
  const a = prefix + "a-00001-of-00002.gguf",
    a2 = prefix + "a-00002-of-00002.gguf",
    b = prefix + "b.gguf",
    p = prefix + "mmproj.gguf",
    small = prefix + "small.gguf";
  const modelPath = resolve(".models/SmolLM2-135M-Instruct.Q4_K_M.gguf");
  const originalSize = (await stat(modelPath)).size;
  await page.locator("#files").setInputFiles(modelPath);
  await page.evaluate(helpers.outputFiles[0].text);
  for (const url of [a, a2, b, p])
    await page.evaluate((data) => globalThis.seedDeletionModel(data), {
      url,
      projector: p,
    });
  await page.evaluate((data) => globalThis.seedDeletionModel(data), {
    url: small,
    local: true,
  });
  await page.evaluate((a) => {
    localStorage.setItem(
      "jev.last-model.v1",
      JSON.stringify({ id: "cache:" + a, label: "a" }),
    );
    localStorage.setItem(
      "jev.runtime-settings.v1",
      JSON.stringify({
        startup: "none",
        maxAutoLoadGiB: 4,
        fallbackModel: "cache:" + a,
        loadSeconds: 180,
        responseSeconds: 240,
      }),
    );
  }, a);
  async function files() {
    await page.evaluate(helpers.outputFiles[0].text);
    return await page.evaluate(() => globalThis.deletionFiles());
  }
  async function remove(id, accept = true) {
    page.once("dialog", (dialog) =>
      accept ? dialog.accept() : dialog.dismiss(),
    );
    await modelRow(page, id).locator('[data-model-action="remove"]').click();
    if (accept)
      await page.waitForFunction(() =>
        document
          .querySelector("#model-remove-status")
          .textContent.includes("削除しました"),
      );
  }
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll("#models > li").length === 3,
  );
  assert.equal(await page.locator("#models select").count(), 0);
  assert.equal(await page.locator("#models > li .model-state").count(), 3);
  await remove("cache:" + a, false);
  assert.equal((await files()).length, 5);
  ok("cancelled deletion leaves all cached files intact");
  await remove("cache:" + a);
  assert.deepEqual((await files()).sort(), [b, p, small].sort());
  assert.equal(
    await page.evaluate(() => localStorage.getItem("jev.last-model.v1")),
    null,
  );
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("jev.runtime-settings.v1"))
          .fallbackModel,
    ),
    "",
  );
  ok(
    "split model deletion removes its shards, clears saved references, and preserves shared projector",
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll("#models > li").length === 2,
  );
  await remove("cache:" + b);
  assert.deepEqual(await files(), [small]);
  ok("removing the final projector user deletes the now-unused image file");
  await loadModel(page, "cache:" + small);
  await page.waitForFunction(
    () => !document.querySelector("#run").disabled,
    null,
    { timeout: 120000 },
  );
  assert.equal(
    await modelRow(page, "cache:" + small)
      .locator(".model-state")
      .textContent(),
    "使用中",
  );
  await remove("cache:" + small);
  assert.equal(await page.locator("#run").isDisabled(), true);
  assert.deepEqual(await files(), []);
  await page.reload();
  await page.waitForFunction(
    () => !document.querySelector("#hardware-save").disabled,
  );
  assert.equal(await page.locator("#models > li").count(), 0);
  ok(
    "loaded cached model unloads before removal and stays deleted after reload",
  );
  await page.locator("#files").setInputFiles(modelPath);
  assert.equal(
    await modelRow(page).locator('[data-model-action="remove"]').textContent(),
    "一覧から削除",
  );
  await remove();
  assert.equal(await page.locator("#models > li").count(), 0);
  assert.equal((await stat(modelPath)).size, originalSize);
  ok(
    "local model removal only unregisters the file and preserves the original GGUF",
  );
  await page.setViewportSize({ width: 480, height: 900 });
  await page
    .locator('[aria-labelledby="model-heading"]')
    .screenshot({ path: ".test-artifacts/model-removal.png" });
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(
    ".test-artifacts/model-removal-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
