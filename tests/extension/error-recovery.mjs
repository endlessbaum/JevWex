import { chromium } from "playwright";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { navigate, fillSingleCriterion, runEvaluation } from "./ui-helpers.mjs";
if (!process.env.JEV_TEST_MODEL)
  throw new Error("Set JEV_TEST_MODEL to a local GGUF");
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
  errors: [],
  requests: [],
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const page = await context.newPage();
  page.on("request", (r) => report.requests.push(r.url()));
  await page.goto(`chrome-extension://${id}/jev.html#models`);
  await context.setOffline(true);
  const ok = (name) => {
    report.passed.push(name);
    console.log("PASS", name);
  };
  await page
    .locator("#files")
    .setInputFiles({
      name: "empty.gguf",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(0),
    });
  assert.match(await page.locator("#error").textContent(), /空でないGGUF/);
  ok("empty local file shows readable validation error");
  await page
    .locator("#files")
    .setInputFiles({
      name: "broken.gguf",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("invalid gguf"),
    });
  await page.locator("#load").click();
  await page.waitForFunction(() => !document.querySelector("#error").hidden);
  assert.equal(await page.locator("#run").isDisabled(), true);
  ok("invalid GGUF fails without enabling evaluation");
  await page.locator("#files").setInputFiles(process.env.JEV_TEST_MODEL);
  await page.locator("#load").click();
  await navigate(page, "judge");
  await page.locator("#state").fill("editable during load");
  await page.waitForFunction(
    () => !document.querySelector("#run").disabled,
    null,
    { timeout: 120000 },
  );
  ok("load recovery while navigating and editing");
  await fillSingleCriterion(page, { text: "cat ".repeat(6000) });
  await page.locator("#run").click();
  await page.waitForFunction(
    () => !document.querySelector("#error").hidden,
    null,
    { timeout: 120000 },
  );
  report.errors.push(await page.locator("#error").textContent());
  assert.match(report.errors.at(-1), /処理できる長さ/);
  ok("context overflow has plain-language explanation");
  await page.locator("#state").fill("The cat sleeps.");
  report.result = (await runEvaluation(page)).response;
  assert.equal(Object.values(report.result.answers)[0].type, "noul");
  ok("successful inference after context error");
  const workers = page.workers();
  await page.close();
  for (const worker of workers) await assert.rejects(worker.evaluate(() => 1));
  ok("closing the owner tab terminates its Worker");
  assert.deepEqual(
    report.requests.filter((x) => /^https?:/.test(x)),
    [],
  );
  ok("zero external page requests");
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  await writeFile(
    ".test-artifacts/error-recovery-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
