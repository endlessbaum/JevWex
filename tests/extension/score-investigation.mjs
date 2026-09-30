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
const report = { browser: context.browser().version(), cases: [], errors: [] };
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await page.goto(`chrome-extension://${id}/jev.html`);
  await navigate(page, "models");
  if (process.env.JEV_TEST_MODEL) {
    await page.locator("#files").setInputFiles(process.env.JEV_TEST_MODEL);
  } else {
    await navigate(page, "models");
    await page.locator("#download-url").fill("unsloth/Qwen3-0.6B-GGUF");
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
  }
  report.model = await page
    .locator("#models > li")
    .last()
    .getAttribute("data-model-id");
  console.log("MODEL", report.model);
  await context.setOffline(true);
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
  await navigate(page, "judge");
  while ((await page.locator(".criterion").count()) > 1)
    await page.locator(".remove-criterion").first().click();
  for (const [name, text] of [
    [
      "explicit_refund",
      "同じ注文の代金が二度請求されています。返金をお願いします。\n注文状況：配達済み",
    ],
    [
      "no_requested_action",
      "同じ注文の代金が二度請求されています。\n注文状況：配達済み",
    ],
    [
      "vague_action",
      "同じ注文の代金が二度請求されています。なんとかしてください。\n注文状況：配達済み",
    ],
  ]) {
    await page.locator("#state").fill(text);
    await page.locator("#run").click();
    await page.waitForFunction(
      () => !document.querySelector("#run").disabled,
      null,
      { timeout: 240000 },
    );
    const error = (await page.locator("#error").isVisible())
      ? await page.locator("#error").textContent()
      : undefined;
    if (error) {
      report.cases.push({ name, text, error });
      console.log("CASE", name, error);
      continue;
    }
    const { response, diagnostics, input } = await downloadResult(page);
    const answer = response.answers.request_specificity;
    const raw = diagnostics.model_outputs[0].raw_output;
    const weights = Object.values(JSON.parse(raw));
    const sum = weights.reduce((a, b) => a + b, 0);
    const expected = weights.reduce((a, b, i) => a + i * b, 0) / sum;
    assert.ok(Math.abs(expected - answer.score) < 1e-12);
    assert.equal(
      await page.locator(".answer .value").textContent(),
      `${Number(answer.score.toFixed(2))} / 2 点`,
    );
    const bars = await page
      .locator(".answer meter")
      .evaluateAll((nodes) => nodes.map((n) => n.value));
    assert.deepEqual(bars, Object.values(answer.probabilities));
    report.cases.push({
      name,
      input,
      raw,
      sum,
      expected,
      answer,
      bars,
      diagnostics,
    });
    console.log(
      "CASE",
      name,
      "raw",
      raw,
      "score",
      answer.score,
      "confidence",
      answer.confidence,
    );
  }
  assert.deepEqual(report.errors, []);
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  await writeFile(
    ".test-artifacts/score-investigation.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
