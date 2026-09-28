import { chromium } from "playwright";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { navigate } from "./ui-helpers.mjs";
await mkdir(".test-artifacts", { recursive: true });
const vision = !!process.env.JEV_BATCH_VISION;
const context = await chromium.launchPersistentContext(
  vision ? resolve(".test-artifacts/vision-profile") : "",
  {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  },
);
const report = {
  browser: context.browser().version(),
  passed: [],
  notRun: [
    "10,000 real LLM evaluations; long overnight execution; low-memory devices",
  ],
};
const ok = (name) => {
  report.passed.push(name);
  console.log("PASS", name);
};
const exported = async (page, selector, json = true) => {
  const pending = page.waitForEvent("download");
  await page.locator(selector).click();
  const file = await pending;
  const text = await readFile(await file.path(), "utf8");
  return json ? JSON.parse(text) : text;
};
const done = async (page) => {
  await page.waitForFunction(
    () => !document.querySelector("#batch-run").disabled,
    null,
    { timeout: 240000 },
  );
  assert.equal(
    await page.locator("#batch-error").isVisible(),
    false,
    await page.locator("#batch-error").textContent(),
  );
};
async function configure(page) {
  const rows = page.locator("#batch-criteria .criterion");
  await rows.nth(0).locator('[data-field="alias"]').fill("色の分類");
  await rows
    .nth(0)
    .locator('[data-field="instructions"]')
    .fill(
      "Choose the dominant color mentioned in the text or shown in the image.",
    );
  for (const [i, color] of ["red", "blue", "other"].entries()) {
    await rows.nth(0).locator('[data-field="label"]').nth(i).fill(color);
    await rows
      .nth(0)
      .locator('[data-field="description"]')
      .nth(i)
      .fill(`The color is ${color}.`);
  }
  await rows.nth(1).locator('[data-field="alias"]').fill("赤の当てはまり");
  await rows
    .nth(1)
    .locator('[data-field="instructions"]')
    .fill("The dominant color is red.");
  await rows.nth(2).locator('[data-field="alias"]').fill("赤の程度");
  await rows
    .nth(2)
    .locator('[data-field="instructions"]')
    .fill("Rate how red the color is, blue=0 purple=1 red=2.");
  for (const [i, color] of ["blue", "purple", "red"].entries()) {
    await rows.nth(2).locator('[data-field="label"]').nth(i).fill(color);
    await rows
      .nth(2)
      .locator('[data-field="description"]')
      .nth(i)
      .fill(`The color is ${color}.`);
  }
}
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await context.setOffline(true);
  let requests = 0;
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests++;
  });
  await page.goto(`chrome-extension://${id}/jev.html#batch`);
  assert.equal(await page.title(), "一括判定 | JevWex");
  assert.equal(await page.locator("#judge-page").isVisible(), false);
  assert.equal(await page.locator("#batch-criteria .criterion").count(), 3);
  await page.locator("#batch-format").selectOption("table");
  await page
    .locator("#batch-source")
    .fill(
      '名前,内容\n同名,"The color is red.\nIt is bright."\n同名,The color is blue.\n空の文章,\n最後,"The color is red.\nIt is bright."',
    );
  await page.locator("#batch-preview-button").click();
  assert.match(await page.locator("#batch-input-count").textContent(), /4件/);
  assert.equal(await page.locator("#batch-content-column").inputValue(), "1");
  assert.equal(await page.locator("#batch-name-column").inputValue(), "0");
  const sourceFile = await page.locator("#batch-source").inputValue();
  await page
    .locator("#batch-file")
    .setInputFiles({
      name: "records.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("\uFEFF" + sourceFile),
    });
  await page.waitForFunction(
    () => !document.querySelector("#batch-file").disabled,
  );
  assert.match(await page.locator("#batch-input-count").textContent(), /4件/);
  await configure(page);
  assert.equal(
    await page.locator('#criteria [data-field="alias"]').first().inputValue(),
    "担当窓口",
  );
  ok(
    "Separate batch page imports quoted multiline CSV, infers columns, keeps duplicate names and independent shared criteria",
  );
  await navigate(page, "hardware");
  await page.waitForFunction(
    () => !document.querySelector("#hardware-save").disabled,
  );
  if (!(await page.locator("#gpu-option").isDisabled()))
    await page.locator("#hardware-device").selectOption("webgpu");
  await page.locator("#hardware-save").click();
  await navigate(page, "models");
  await page
    .locator("#files")
    .setInputFiles(resolve(".models/qwen2.5-0.5b-instruct-q4_k_m.gguf"));
  await page.locator("#load").click();
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
  await navigate(page, "batch");
  await page.locator("#batch-run").click();
  assert.equal(await page.locator("#load").isDisabled(), true);
  assert.equal(
    await page
      .locator('#batch-criteria [data-field="alias"]')
      .first()
      .isDisabled(),
    true,
  );
  await done(page);
  report.text = await exported(page, "#batch-json");
  assert.deepEqual(
    report.text.rows.map((row) => row.status),
    ["success", "success", "error", "success"],
  );
  assert.equal(report.text.summary.totals.success, 3);
  assert.equal(report.text.summary.totals.error, 1);
  const scoreId = Object.keys(report.text.questions).find(
    (id) => report.text.questions[id].type === "score",
  );
  const scoreMean =
    report.text.rows
      .filter((row) => row.status === "success")
      .reduce(
        (sum, row) => sum + row.result.response.answers[scoreId].score,
        0,
      ) / 3;
  assert.equal(report.text.summary.criteria[scoreId].mean, scoreMean);
  assert.match(
    await page.locator("#batch-summary-note").textContent(),
    /完了した3件/,
  );
  await page.locator("#batch-rows details").first().locator("summary").click();
  assert.match(
    await page.locator("#batch-rows details").first().textContent(),
    /bright/,
  );
  const csv = await exported(page, "#batch-csv", false),
    summary = await exported(page, "#batch-summary-csv", false);
  assert.match(csv, /同名/);
  assert.match(csv, /空の文章/);
  assert.match(summary, /色の分類/);
  await page.locator("#batch-filter").selectOption("error");
  assert.equal(await page.locator(".batch-result-row").count(), 1);
  await page.locator("#batch-filter").selectOption("all");
  await page.locator("#batch-search").fill("最後");
  assert.equal(await page.locator(".batch-result-row").count(), 1);
  await page.locator("#batch-search").fill("");
  await page.screenshot({
    path: ".test-artifacts/batch-desktop.png",
    fullPage: true,
  });
  ok(
    "Real mixed-type text batch isolates empty row, computes verified aggregates, shows per-row detail and exports CSV/JSON",
  );
  await page.locator("#batch-format").selectOption("lines");
  await page
    .locator("#batch-source")
    .fill(Array(6).fill("The color is blue.").join("\n"));
  await page.locator("#batch-run").click();
  await page.waitForFunction(
    () =>
      /完了 [1-5]件/.test(
        document.querySelector("#batch-progress-text").textContent,
      ),
    null,
    { timeout: 120000 },
  );
  await page.locator("#batch-cancel").click();
  await done(page);
  const stopped = await exported(page, "#batch-json");
  assert.ok(
    stopped.summary.totals.success > 0 && stopped.summary.totals.success < 6,
  );
  const succeeded = stopped.rows
    .filter((row) => row.status === "success")
    .map((row) => row.result);
  const original = stopped.questions;
  await page
    .locator('#batch-criteria [data-field="instructions"]')
    .first()
    .fill("An edit for a future run, not for resume.");
  await page.locator("#batch-resume").click();
  await done(page);
  const resumed = await exported(page, "#batch-json");
  assert.equal(resumed.summary.totals.success, 6);
  assert.deepEqual(resumed.questions, original);
  assert.deepEqual(
    resumed.rows.slice(0, succeeded.length).map((row) => row.result),
    succeeded,
  );
  report.cancelled = stopped.summary.totals;
  report.resumed = resumed.summary.totals;
  ok(
    "Cancellation preserves completed rows; resume reuses original criteria and avoids reevaluating successes",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: ".test-artifacts/batch-mobile.png",
    fullPage: true,
  });
  ok("Mobile layout confines wide result tables to horizontal table scrolling");
  await page.setViewportSize({ width: 1440, height: 1000 });
  while ((await page.locator("#batch-criteria .criterion").count()) > 1)
    await page.locator("#batch-criteria .remove-criterion").last().click();
  await page
    .locator('#batch-criteria [data-field="type"]')
    .selectOption("noul");
  await page
    .locator('#batch-criteria [data-field="instructions"]')
    .fill("The text mentions blue.");
  await page
    .locator("#batch-source")
    .fill(Array(55).fill("The color is blue.").join("\n"));
  await page.locator("#batch-run").click();
  await done(page);
  const many = await exported(page, "#batch-json");
  assert.equal(many.summary.totals.success, 55);
  assert.equal(await page.locator(".batch-result-row").count(), 50);
  await page.locator("#batch-next").click();
  assert.equal(await page.locator(".batch-result-row").count(), 5);
  assert.equal(
    await page.locator(".batch-result-row td").first().textContent(),
    "51",
  );
  report.many = many.summary;
  ok(
    "55 real text evaluations finish; individual results paginate 50 + 5 without omissions",
  );
  if (vision) {
    await navigate(page, "models");
    const model = await page
      .locator("#models option")
      .evaluateAll((options) =>
        options
          .map((o) => o.value)
          .find(
            (value) =>
              value.startsWith("cache:") && value.includes("LFM2.5-VL"),
          ),
      );
    assert.ok(model, "Run test:extension:vision first to cache LFM2.5-VL-3B");
    await page.locator("#models").selectOption(model);
    await page.locator("#load").click();
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
    await navigate(page, "batch");
    await page.locator("#batch-copy-criteria").click();
    await configure(page);
    const criteria = page.locator("#batch-criteria .criterion");
    await criteria
      .nth(0)
      .locator('[data-field="instructions"]')
      .fill("Choose the dominant color of the attached image.");
    await criteria
      .nth(1)
      .locator('[data-field="instructions"]')
      .fill("The attached image is predominantly red.");
    await criteria
      .nth(2)
      .locator('[data-field="instructions"]')
      .fill(
        "Rate how red the attached image is. Blue is level zero; red is level two.",
      );
    for (const [i, color] of ["blue", "purple", "red"].entries())
      await criteria
        .nth(2)
        .locator('[data-field="description"]')
        .nth(i)
        .fill(`The image is predominantly ${color}.`);
    const files = [];
    for (let i = 0; i < 9; i++) {
      const data = await page.evaluate(
        (color) => {
          const c = document.createElement("canvas");
          c.width = c.height = 128;
          const ctx = c.getContext("2d");
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 128, 128);
          return c.toDataURL().split(",")[1];
        },
        i % 2 ? "blue" : "red",
      );
      files.push({
        name: `image-${i}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(data, "base64"),
      });
    }
    files.push({
      name: "broken.png",
      mimeType: "image/png",
      buffer: Buffer.from("broken"),
    });
    await page.locator("#batch-format").selectOption("images");
    await page.locator("#batch-images").setInputFiles([...files, files[0]]);
    assert.match(await page.locator("#batch-error").textContent(), /10枚/);
    await page.locator("#batch-images").setInputFiles(files);
    assert.match(
      await page.locator("#batch-input-count").textContent(),
      /10件/,
    );
    await page.locator("#batch-run").click();
    await done(page);
    report.images = await exported(page, "#batch-json");
    assert.equal(report.images.summary.totals.success, 9);
    assert.equal(report.images.summary.totals.error, 1);
    for (const [i, row] of report.images.rows.slice(0, 9).entries()) {
      assert.equal(row.result.diagnostics.images.length, 1);
      assert.equal(row.result.diagnostics.images[0].name, `image-${i}.png`);
    }
    await page.screenshot({
      path: ".test-artifacts/batch-images.png",
      fullPage: true,
    });
    ok(
      "Ten-image batch with real LFM2.5-VL: nine valid images evaluated individually, corrupt image isolated; eleven images rejected",
    );
  } else
    report.notRun.push(
      "Vision batch: set JEV_BATCH_VISION=1 after caching the model",
    );
  assert.deepEqual(errors, []);
  assert.equal(requests, 0);
  ok("No page errors or external HTTP requests during batch processing");
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await writeFile(
    ".test-artifacts/batch-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
