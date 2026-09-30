import { loadModel } from "./ui-helpers.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { navigate, fillSingleCriterion, runEvaluation } from "./ui-helpers.mjs";

// Reuses the vision test's cached model and projector; never downloads models.
const context = await chromium.launchPersistentContext(
  resolve(".test-artifacts/vision-profile"),
  {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  },
);
const report = { passed: [], errors: [], runs: [], projectorLogs: [] };
const ok = (name) => {
  report.passed.push(name);
  console.log("PASS", name);
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.removeItem("jev.last-model.v1"));
  page.on("console", (message) => {
    const text = message.text();
    if (/clip.*backend|using .* backend|mmproj.*offload/i.test(text))
      report.projectorLogs.push(text.slice(0, 1000));
  });
  await page.goto(`chrome-extension://${id}/index.html#hardware`);
  await page.waitForFunction(
    () => !document.querySelector("#hardware-save").disabled,
  );
  await page.locator("#hardware-reset").click();
  assert.equal(await page.locator("#hardware-mmproj").inputValue(), "auto");
  await page.locator("#hardware-device").selectOption("webgpu");
  await page.locator("#hardware-mmproj").selectOption("cpu");
  await page.locator("#hardware-save").click();
  await page.reload();
  await page.waitForFunction(
    () => !document.querySelector("#hardware-save").disabled,
  );
  assert.equal(await page.locator("#hardware-device").inputValue(), "webgpu");
  assert.equal(await page.locator("#hardware-mmproj").inputValue(), "cpu");
  ok(
    "mmproj CPU preference persists while model device stays WebGPU; reset restores automatic behavior",
  );
  await page.locator("#hardware-mmproj").selectOption("auto");
  await page.locator("#hardware-save").click();
  await navigate(page, "models");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#models > li")].some((o) =>
      /LFM2.5-VL/.test(o.textContent),
    ),
  );
  const model = await page
    .locator("#models")
    .evaluate(
      (el) =>
        [...el.children].find((o) => /LFM2.5-VL/.test(o.textContent)).dataset
          .modelId,
    );
  await context.setOffline(true);
  await loadModel(page, model);
  await page.waitForFunction(
    () =>
      document
        .querySelector("#image-hint")
        .textContent.includes("現在のモデルは画像に対応"),
    null,
    { timeout: 200000 },
  );
  await navigate(page, "hardware");
  assert.match(
    await page.locator("#hardware-current").textContent(),
    /mmproj GPUを要求/,
  );
  await page.locator("#hardware-mmproj").selectOption("cpu");
  await page.locator("#hardware-save").click();
  assert.match(
    await page.locator("#hardware-current").textContent(),
    /mmproj GPUを要求/,
  );
  assert.match(
    await page.locator("#hardware-status").textContent(),
    /再読み込み/,
  );
  await page.locator("#hardware-apply").click();
  await page.waitForFunction(
    () => !document.querySelector("#hardware-apply").disabled,
    null,
    { timeout: 200000 },
  );
  assert.equal(
    await page.locator("#error").isVisible(),
    false,
    await page.locator("#error").textContent(),
  );
  assert.match(
    await page.locator("#hardware-current").textContent(),
    /GPU [1-9]\d*層.*mmproj CPU/,
  );
  ok(
    "changing only mmproj reloads the same VLM; language model remains on GPU and projector is requested on CPU",
  );
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: ".test-artifacts/mmproj-hardware.png",
    fullPage: true,
  });
  await fillSingleCriterion(page, {
    text: "",
    instructions: "The attached image is predominantly red.",
  });
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 128, 128);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#images").setInputFiles({
    name: "red.png",
    mimeType: "image/png",
    buffer: Buffer.from(bytes, "base64"),
  });
  const result = await runEvaluation(page);
  assert.equal(result.diagnostics.hardware.requested.mmprojDevice, "cpu");
  assert.equal(result.diagnostics.hardware.requested.device, "webgpu");
  assert.ok(result.diagnostics.hardware.gpu_layers_offloaded > 0);
  assert.equal(result.diagnostics.supports_images, true);
  report.runs.push(result);
  ok(
    "real cached LFM2.5-VL performs image-only inference offline with model GPU plus mmproj CPU",
  );
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  throw error;
} finally {
  await writeFile(
    "docs/mmproj-test-results.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
