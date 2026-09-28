import { chromium } from "playwright";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { navigate, fillSingleCriterion, runEvaluation } from "./ui-helpers.mjs";
await mkdir(".test-artifacts", { recursive: true });
const launch = () =>
  chromium.launchPersistentContext(resolve(".test-artifacts/resume-profile"), {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
let context = await launch();
const report = {
  browser: context.browser().version(),
  passed: [],
  notRun: [
    "Low-memory startup failure; other browser versions; real GPU loss between launches",
  ],
};
const ok = (name) => {
  report.passed.push(name);
  console.log("PASS", name);
};
const install = async () => {
  const cdp = await context.browser().newBrowserCDPSession();
  return (await cdp.send("Extensions.loadUnpacked", { path: resolve("dist") }))
    .id;
};
const ready = async (page) => {
  await page.waitForFunction(
    () =>
      !document.querySelector("#run").disabled ||
      document
        .querySelector("#startup-status")
        .textContent.includes("できませんでした") ||
      !document.querySelector("#error").hidden,
    null,
    { timeout: 190000 },
  );
  assert.equal(
    await page.locator("#run").isDisabled(),
    false,
    (await page.locator("#startup-status").textContent()) +
      (await page.locator("#error").textContent()),
  );
};
try {
  const id = await install();
  let page = await context.newPage();
  await page.goto(`chrome-extension://${id}/jev.html#models`);
  // Repeated test runs reuse downloads, but start with no remembered model.
  await page.evaluate(() => localStorage.removeItem("jev.last-model.v1"));
  await page.reload();
  await page
    .locator("#download-url")
    .fill("QuantFactory/SmolLM2-135M-Instruct-GGUF");
  await page.locator("#download").click();
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
    null,
    { timeout: 240000 },
  );
  assert.match(
    await page.locator("#download-status").textContent(),
    /保存完了/,
  );
  await navigate(page, "hardware");
  await page.waitForFunction(
    () => !document.querySelector("#hardware-save").disabled,
  );
  await page.locator("#hardware-device").selectOption("cpu");
  await page.locator("#hardware-threads").selectOption("2");
  await page.locator("#hardware-context").selectOption("2048");
  await page.locator("#hardware-save").click();
  await navigate(page, "models");
  await page.locator("#load").click();
  await ready(page);
  const remembered = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("jev.last-model.v1")),
  );
  assert.match(remembered.id, /^cache:/);
  await page
    .locator("#files")
    .setInputFiles(resolve(".models/SmolLM2-135M-Instruct.Q4_K_M.gguf"));
  assert.notEqual(await page.locator("#models").inputValue(), remembered.id);
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("jev.last-model.v1")),
    ),
    remembered,
  );
  ok(
    "Successful load records model; merely selecting another model does not replace it",
  );
  await context.close();
  context = await launch();
  await context.setOffline(true);
  const nextId = await install();
  assert.equal(nextId, id);
  page = await context.newPage();
  const requests = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await page.goto(`chrome-extension://${id}/jev.html`);
  await ready(page);
  assert.equal(await page.locator("#judge-page").isVisible(), true);
  assert.equal(await page.locator("#models").inputValue(), remembered.id);
  assert.match(
    await page.locator("#model-hint").textContent(),
    /CPU 2スレッド.*2,048/,
  );
  await fillSingleCriterion(page);
  report.result = await runEvaluation(page);
  assert.equal(report.result.diagnostics.threads, 2);
  assert.equal(report.result.diagnostics.context, 2048);
  assert.deepEqual(requests, []);
  ok(
    "Browser restart restores cached model and CPU settings offline; judge is ready and real inference succeeds",
  );
  await navigate(page, "hardware");
  if (!(await page.locator("#gpu-option").isDisabled())) {
    await page.locator("#hardware-device").selectOption("webgpu");
    await page.locator("#hardware-apply").click();
    await ready(page);
    await page.goto(`chrome-extension://${id}/jev.html`);
    await ready(page);
    assert.match(await page.locator("#model-hint").textContent(), /GPU/);
    await fillSingleCriterion(page);
    report.gpuResult = await runEvaluation(page);
    assert.equal(
      report.gpuResult.diagnostics.hardware.requested.device,
      "webgpu",
    );
    assert.ok(report.gpuResult.diagnostics.hardware.gpu_layers_offloaded > 0);
    assert.deepEqual(requests, []);
    ok(
      "WebGPU settings restore on reopening and real GPU inference succeeds offline",
    );
  } else report.notRun.push("GPU restoration: no GPU detected");
  // Preserve the last working model if another GGUF fails to load.
  await navigate(page, "models");
  await page.locator("#files").setInputFiles({
    name: "broken.gguf",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not a model"),
  });
  await page.locator("#load").click();
  await page.waitForFunction(
    () => !document.querySelector("#error").hidden,
    null,
    { timeout: 190000 },
  );
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("jev.last-model.v1")),
    ),
    remembered,
  );
  ok("Failed model load preserves the last successful model");
  await page.evaluate(() =>
    localStorage.setItem(
      "jev.last-model.v1",
      JSON.stringify({ id: "cache:missing.gguf", label: "消えたモデル" }),
    ),
  );
  await page.goto(`chrome-extension://${id}/jev.html`);
  await page.waitForFunction(() =>
    document
      .querySelector("#startup-status")
      .textContent.includes("見つかりません"),
  );
  assert.equal(await page.locator("#run").isDisabled(), true);
  assert.deepEqual(requests, []);
  ok(
    "Missing cache shows recovery guidance without downloading or loading a different model",
  );
  await navigate(page, "models");
  await page
    .locator("#files")
    .setInputFiles(resolve(".models/SmolLM2-135M-Instruct.Q4_K_M.gguf"));
  await page.locator("#load").click();
  await ready(page);
  await page.goto(`chrome-extension://${id}/jev.html`);
  await page.waitForFunction(() =>
    document
      .querySelector("#startup-status")
      .textContent.includes("同じ端末のファイル"),
  );
  assert.equal(await page.locator("#run").isDisabled(), true);
  assert.match(await page.locator("#startup-status").textContent(), /SmolLM2/);
  ok("Local-file model name is remembered with a clear reselection message");
  await page.screenshot({
    path: ".test-artifacts/resume-local.png",
    fullPage: true,
  });
  await page.evaluate((remembered) => {
    localStorage.setItem("jev.last-model.v1", JSON.stringify(remembered));
    const hw = JSON.parse(localStorage.getItem("jev.hardware.v1"));
    hw.threads = 32;
    localStorage.setItem("jev.hardware.v1", JSON.stringify(hw));
  }, remembered);
  if (await page.evaluate(() => navigator.hardwareConcurrency < 32)) {
    await page.reload();
    await page.waitForFunction(() =>
      document
        .querySelector("#startup-status")
        .textContent.includes("自動読み込みができません"),
    );
    await navigate(page, "hardware");
    await page.locator("#hardware-threads").selectOption("2");
    await page.locator("#hardware-save").click();
    await navigate(page, "models");
    await page.locator("#load").click();
    await ready(page);
    ok(
      "Unavailable hardware setting stops auto-load; correcting settings permits manual recovery",
    );
  }
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  await writeFile(
    ".test-artifacts/resume-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
