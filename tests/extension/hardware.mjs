import { loadModel } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { navigate, fillSingleCriterion, runEvaluation } from "./ui-helpers.mjs";
if (!process.env.JEV_TEST_MODEL) throw new Error("Set JEV_TEST_MODEL");
await mkdir(".test-artifacts", { recursive: true });
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"],
});
const report = {
  browser: context.browser().version(),
  passed: [],
  notRun: [],
  runs: [],
  errors: [],
  requests: [],
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(String(e)));
  page.on("request", (r) => report.requests.push(r.url()));
  const ok = (name) => {
    report.passed.push(name);
    console.log("PASS", name);
  };
  await page.goto(`chrome-extension://${id}/jev.html#hardware`);
  await page.waitForFunction(
    () => !document.querySelector("#hardware-save").disabled,
  );
  report.capabilities = await page.evaluate(() => ({
    isolated: crossOriginIsolated,
    shared: typeof SharedArrayBuffer !== "undefined",
    cores: navigator.hardwareConcurrency,
    cpu: document.querySelector("#hardware-cpu").textContent,
    gpu: document.querySelector("#hardware-gpu").textContent,
    gpuReason: document.querySelector("#hardware-gpu-reason").textContent,
    gpuEnabled: !document.querySelector("#gpu-option").disabled,
  }));
  console.log("CAPABILITIES", JSON.stringify(report.capabilities));
  assert.equal(report.capabilities.isolated, true);
  assert.equal(report.capabilities.shared, true);
  await page.locator("#hardware-threads").selectOption("1");
  await page.locator("#hardware-save").click();
  await page.reload();
  await page.waitForFunction(
    () => !document.querySelector("#hardware-save").disabled,
  );
  assert.equal(await page.locator("#hardware-threads").inputValue(), "1");
  ok("settings persist; real extension enables isolated shared memory");
  await context.setOffline(true);
  await navigate(page, "models");
  await page.locator("#files").setInputFiles(process.env.JEV_TEST_MODEL);
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
  await fillSingleCriterion(page);
  let output = await runEvaluation(page);
  assert.equal(output.diagnostics.threads, 1);
  report.runs.push({ mode: "cpu1", diagnostics: output.diagnostics });
  console.log("TIMING cpu1", output.diagnostics.evaluation_ms);
  ok("explicit one-thread CPU loads and evaluates");
  await navigate(page, "hardware");
  const threads = String(Math.min(4, report.capabilities.cores));
  await page.locator("#hardware-threads").selectOption(threads);
  await page.locator("#hardware-context").selectOption("2048");
  await page.locator("#hardware-save").click();
  assert.match(
    await page.locator("#hardware-current").textContent(),
    /1スレッド/,
  );
  await page.locator("#hardware-apply").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#hardware-apply").disabled ||
      !document.querySelector("#error").hidden,
    null,
    { timeout: 190000 },
  );
  assert.equal(
    await page.locator("#error").isVisible(),
    false,
    await page.locator("#error").textContent(),
  );
  await navigate(page, "judge");
  output = await runEvaluation(page);
  assert.equal(output.diagnostics.threads, Number(threads));
  assert.equal(output.diagnostics.context, 2048);
  assert.ok(
    output.diagnostics.generation > report.runs[0].diagnostics.generation,
  );
  report.runs.push({ mode: `cpu${threads}`, diagnostics: output.diagnostics });
  console.log("TIMING cpuMulti", output.diagnostics.evaluation_ms);
  ok(
    "saving does not mutate loaded runtime; apply reloads same model with actual multiple threads",
  );
  await navigate(page, "hardware");
  if (report.capabilities.gpuEnabled) {
    await page.locator("#hardware-device").selectOption("webgpu");
    await page.locator("#hardware-apply").click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#hardware-apply").disabled ||
        !document.querySelector("#error").hidden,
      null,
      { timeout: 190000 },
    );
    if (await page.locator("#error").isVisible()) {
      report.gpuLoadError = await page.locator("#error").textContent();
      console.log("GPU LOAD FAILED", report.gpuLoadError);
      report.notRun.push("GPU inference: load failed in this browser/device");
    } else {
      await navigate(page, "judge");
      output = await runEvaluation(page);
      report.runs.push({ mode: "webgpu", diagnostics: output.diagnostics });
      console.log(
        "GPU RESULT",
        JSON.stringify(output.diagnostics.hardware),
        output.diagnostics.evaluation_ms,
      );
      assert.equal(output.diagnostics.hardware.requested.device, "webgpu");
      if (output.diagnostics.hardware.gpu_layers_offloaded > 0)
        ok(
          "WebGPU model offload confirmed through public logs and real inference",
        );
      else
        report.notRun.push("actual GPU offload not confirmed by upstream logs");
      await navigate(page, "hardware");
    }
  } else
    report.notRun.push(
      "GPU inference: adapter unavailable; GPU option disabled",
    );
  await page.screenshot({
    path: ".test-artifacts/hardware-page.png",
    fullPage: true,
  });
  assert.deepEqual(
    report.requests.filter((u) => /^https?:/.test(u)),
    [],
  );
  ok("no external requests during CPU/GPU load and inference");
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  await writeFile(
    ".test-artifacts/hardware-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
