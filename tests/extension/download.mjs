import { loadModel } from "./ui-helpers.mjs";
import {
  navigate,
  fillSingleCriterion,
  downloadResult,
} from "./ui-helpers.mjs";
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
  passed: [],
  requests: [],
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const page = await context.newPage();
  page.on("request", (r) =>
    report.requests.push({ method: r.method(), url: r.url().split("?")[0] }),
  );
  await page.goto(`chrome-extension://${id}/jev.html`);
  await navigate(page, "models");
  const ok = (x) => {
    report.passed.push(x);
    console.log("PASS", x);
  };
  await page.locator("#download-url").fill("https://example.com/test.gguf");
  await page.locator("#download").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#download-status")
      .textContent.includes("公開GGUF直接URL"),
  );
  ok("unapproved origin rejected before network");
  await page.locator("#download-example").click();
  const url = await page.locator("#download-url").inputValue();
  report.model = url;
  await page.locator("#download").click();
  await page.waitForFunction(
    () => document.querySelector("#download-progress").value > 0,
    null,
    { timeout: 120000 },
  );
  await page.locator("#download-cancel").click();
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
    null,
    { timeout: 120000 },
  );
  assert.match(
    await page.locator("#download-status").textContent(),
    /中止しました/,
  );
  assert.equal(await page.locator("#models > li").count(), 0);
  ok("real download cancel never registers partial model");
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
  assert.equal(await page.locator("#models > li").count(), 1);
  ok("real HTTPS download and OPFS cache completed");
  const selected = await page
    .locator("#models > li")
    .last()
    .getAttribute("data-model-id");
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll("#models > li").length === 1,
  );
  assert.equal(
    await page.locator("#models > li").first().getAttribute("data-model-id"),
    selected,
  );
  ok("downloaded model survives reload while offline");
  const before = report.requests.length;
  await navigate(page, "models");
  await page.locator("#download-example").click();
  await page.locator("#download").click();
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  assert.match(
    await page.locator("#download-status").textContent(),
    /保存完了/,
  );
  assert.equal(report.requests.length, before);
  ok("duplicate download reuses cache without network");
  await loadModel(page);
  await page.waitForFunction(
    () => !document.querySelector("#run").disabled,
    null,
    { timeout: 120000 },
  );
  ok("cached model loads with packaged Worker/WASM offline");
  const criterion = await fillSingleCriterion(page);
  const criterionId = await criterion.getAttribute("data-id");
  const beforeInference = report.requests.length;
  await page.locator("#run").click();
  await page.waitForFunction(
    () => !document.querySelector("#run").disabled,
    null,
    { timeout: 120000 },
  );
  assert.equal(
    await page.locator("#error").isVisible(),
    false,
    await page.locator("#error").textContent(),
  );
  report.result = (await downloadResult(page)).response;
  assert.equal(report.result.answers[criterionId].type, "noul");
  assert.equal(report.requests.length, beforeInference);
  ok("real cached-model inference sends no network requests");
  await page.screenshot({
    path: ".test-artifacts/download-page.png",
    fullPage: true,
  });
  assert.ok(
    report.requests
      .filter((r) => r.url.startsWith("https:"))
      .every((r) =>
        ["huggingface.co", "us.aws.cdn.hf.co"].includes(
          new URL(r.url).hostname,
        ),
      ),
  );
  ok("actual redirect hosts match limited permissions");
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  await writeFile(
    ".test-artifacts/download-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
