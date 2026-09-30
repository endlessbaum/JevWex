import { loadModel } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fillSingleCriterion, runEvaluation, navigate } from "./ui-helpers.mjs";
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
  requests: [],
  errors: [],
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1080 });
  page.on("request", (r) => report.requests.push(r.url()));
  page.on("pageerror", (e) => report.errors.push(String(e)));
  const ok = (name) => {
    report.passed.push(name);
    console.log("PASS", name);
  };
  await page.goto(`chrome-extension://${id}/index.html`);
  assert.equal(await page.title(), "判定 | JevWex");
  assert.equal(await page.locator("#model-page").isVisible(), false);
  assert.equal(await page.locator(".criterion").count(), 3);
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /JSON|questions|criteria|instructions|質問ID|state/,
  );
  ok("judge page has ordinary fields and no JSON or internal vocabulary");
  const first = page.locator(".criterion").first();
  const stableId = await first.getAttribute("data-id");
  await first.locator('[data-field="alias"]').fill("振り分け先");
  assert.equal(await first.getAttribute("data-id"), stableId);
  await first.locator(".add-label").click();
  assert.equal(await first.locator(".label-row").count(), 4);
  await first.locator('[data-field="label"]').last().fill("新しい窓口");
  await first
    .locator('[data-field="description"]')
    .last()
    .fill("新しい窓口の説明");
  await first.locator(".remove-label").last().click();
  assert.equal(await first.locator(".label-row").count(), 3);
  ok("alias changes independently of id; choice labels add and remove");
  const score = page.locator(".criterion").nth(2);
  await score.locator('[data-field="label"]').nth(0).fill("低い");
  const description = await score
    .locator('[data-field="description"]')
    .nth(0)
    .inputValue();
  await score.locator(".move-down").nth(0).click();
  assert.equal(
    await score.locator('[data-field="label"]').nth(1).inputValue(),
    "低い",
  );
  assert.equal(
    await score.locator('[data-field="description"]').nth(1).inputValue(),
    description,
  );
  await score.locator(".add-label").click();
  assert.equal(await score.locator(".label-row").count(), 4);
  await score.locator(".remove-label").last().click();
  await score.locator('[data-field="type"]').selectOption("noul");
  assert.equal(await score.locator(".label-row").count(), 0);
  await score.locator('[data-field="type"]').selectOption("score");
  assert.equal(
    await score.locator('[data-field="label"]').nth(1).inputValue(),
    "低い",
  );
  ok(
    "score stages reorder together with descriptions and survive type switching",
  );
  await page.locator("#state").fill("画面を切り替えても残る文章");
  await navigate(page, "models");
  assert.equal(await page.locator("#judge-page").isVisible(), false);
  assert.equal(await page.locator("#model-page").isVisible(), true);
  await page.screenshot({
    path: ".test-artifacts/ui-models.png",
    fullPage: true,
  });
  await page.goBack();
  await page.locator("#judge-page").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#state").inputValue(),
    "画面を切り替えても残る文章",
  );
  assert.equal(
    await first.locator('[data-field="alias"]').inputValue(),
    "振り分け先",
  );
  ok("separate page navigation and browser Back preserve edited inputs");
  await page.locator("#add-criterion").click();
  assert.equal(await page.locator(".criterion").count(), 4);
  assert.notEqual(
    await page.locator(".criterion").last().getAttribute("data-id"),
    stableId,
  );
  await page.locator(".remove-criterion").last().click();
  ok("criteria add and remove with generated ids");
  await page.locator("#sample").click();
  await page.screenshot({
    path: ".test-artifacts/ui-judge.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: ".test-artifacts/ui-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1080 });
  ok("desktop and mobile layouts render without horizontal overflow");
  if (process.env.JEV_TEST_MODEL) {
    await navigate(page, "models");
    await context.setOffline(true);
    await page.locator("#files").setInputFiles(process.env.JEV_TEST_MODEL);
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
    const loaded = await page.locator("#loaded").textContent();
    await navigate(page, "judge");
    await navigate(page, "models");
    assert.equal(await page.locator("#loaded").textContent(), loaded);
    const row = await fillSingleCriterion(page, {
      alias: "文章の詳しさ",
      type: "score",
      instructions: "Rate the detail in the text.",
      text: "The cat sleeps on a sofa.",
    });
    await row.locator('[data-field="label"]').nth(0).fill("Brief");
    await row
      .locator('[data-field="description"]')
      .nth(0)
      .fill("Only names a subject.");
    await row.locator('[data-field="label"]').nth(1).fill("Detailed");
    await row
      .locator('[data-field="description"]')
      .nth(1)
      .fill("Describes an action and a place.");
    const rowId = await row.getAttribute("data-id");
    const payload = await runEvaluation(page);
    assert.equal(payload.response.answers[rowId].type, "score");
    assert.equal(payload.presentation[rowId].alias, "文章の詳しさ");
    assert.deepEqual(payload.presentation[rowId].labels, ["Brief", "Detailed"]);
    assert.deepEqual(
      payload.input.questions[rowId].criteria.map((x) => x.label),
      ["Brief", "Detailed"],
    );
    assert.equal(
      await page.locator(".answer h3").textContent(),
      "文章の詳しさ",
    );
    assert.match(await page.locator(".answer").innerText(), /Brief/);
    assert.doesNotMatch(
      await page.locator(".answer").innerText(),
      /confidence|department|JSON/,
    );
    report.result = payload;
    ok(
      "offline model survives navigation; real score displays alias and exports labels, input, raw output",
    );
    await page.screenshot({
      path: ".test-artifacts/ui-results.png",
      fullPage: true,
    });
    await row.locator('[data-field="alias"]').fill("変更後の名前");
    assert.match(await page.locator("#result-note").textContent(), /前回/);
    assert.equal(
      await page.locator(".answer h3").textContent(),
      "文章の詳しさ",
    );
    ok("old result retains its original alias after edits");
    await row.locator('[data-field="label"]').nth(1).fill("Brief");
    await page.locator("#run").click();
    assert.match(await page.locator("#error").textContent(), /ラベルが重複/);
    ok("duplicate labels show a plain-language validation error");
    await navigate(page, "models");
    await page.locator('[data-model-action="unload"]:visible').click();
    await page.waitForFunction(() => document.querySelector("#run").disabled);
    await navigate(page, "judge");
    assert.match(await page.locator("#judge-model").textContent(), /未準備/);
    ok("releasing the model is reflected on the judge page");
  } else
    report.notRun.push(
      "real model inference and result download: set JEV_TEST_MODEL",
    );
  assert.deepEqual(report.errors, []);
  assert.deepEqual(
    report.requests.filter((u) => /^https?:/.test(u)),
    [],
  );
  const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.host_permissions, [
    "https://huggingface.co/*",
    "https://us.aws.cdn.hf.co/*",
  ]);
  assert.deepEqual(manifest.permissions, [
    "activeTab",
    "tabs",
    "scripting",
    "storage",
    "sidePanel",
  ]);
  ok(
    "real MV3 CSP; no page errors or external requests; explicit page-capture permissions",
  );
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  await writeFile(
    ".test-artifacts/extension-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
