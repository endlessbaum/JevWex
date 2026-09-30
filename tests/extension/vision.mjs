import { loadModel } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { navigate, runEvaluation } from "./ui-helpers.mjs";

await mkdir(".test-artifacts", { recursive: true });
const context = await chromium.launchPersistentContext(
  resolve(".test-artifacts/vision-profile"),
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
  results: [],
  notRun: [
    "Other vision models; broad image accuracy benchmark; low-memory devices",
  ],
};
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
  const logs = [];
  report.console = logs;
  page.on("console", (message) => logs.push(message.text().slice(0, 1000)));
  page.on("pageerror", (error) => logs.push(String(error)));
  await page.goto(`chrome-extension://${id}/jev.html`);
  const fixture = async (color) => ({
    name: `${color}.png`,
    mimeType: "image/png",
    buffer: Buffer.from(
      await page.evaluate((color) => {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 256, 256);
        return canvas.toDataURL("image/png").split(",")[1];
      }, color),
      "base64",
    ),
  });
  const red = await fixture("red"),
    blue = await fixture("blue");
  await page.locator("#images").setInputFiles(red);
  await page.waitForFunction(
    () => document.querySelectorAll("#image-previews img").length === 1,
  );
  assert.ok(
    await page
      .locator("#image-previews img")
      .evaluate((img) => img.complete && img.naturalWidth === 256),
  );
  await page.locator("#images").setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await page.waitForFunction(() => !document.querySelector("#error").hidden);
  assert.equal(await page.locator("#image-previews img").count(), 1);
  await page.locator("#image-previews button").click();
  assert.equal(await page.locator("#image-previews img").count(), 0);
  ok("Image preview/removal and corrupt-image rejection in built extension");
  await navigate(page, "models");
  await page.locator("#download-vision-example").click();
  await page.locator("#download").click();
  const timer = setInterval(
    async () =>
      console.log(
        "DOWNLOAD",
        await page
          .locator("#download-status")
          .textContent()
          .catch(() => ""),
      ),
    20000,
  );
  try {
    await page.waitForFunction(
      () => !document.querySelector("#download").disabled,
      null,
      { timeout: 900000 },
    );
  } finally {
    clearInterval(timer);
  }
  assert.match(
    await page.locator("#download-status").textContent(),
    /保存完了/,
  );
  report.files = await page.locator("#download-resolved").textContent();
  assert.match(report.files, /mmproj/);
  ok("Official LFM2.5-VL-3B repository downloads model and projector together");
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll("#models > li").length > 0,
  );
  await page.locator("#download-vision-example").click();
  await page.locator("#download").click();
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  assert.match(
    await page.locator("#download-status").textContent(),
    /保存完了/,
  );
  assert.match(
    await page.locator("#download-resolved").textContent(),
    /mmproj/,
  );
  ok("Model and projector remain paired after reload and are reusable offline");
  await navigate(page, "hardware");
  await page.waitForFunction(
    () => !document.querySelector("#hardware-save").disabled,
  );
  await page
    .locator("#hardware-device")
    .selectOption(process.env.JEV_VISION_CPU ? "cpu" : "webgpu");
  await page.locator("#hardware-context").selectOption("4096");
  await page.locator("#hardware-save").click();
  await navigate(page, "models");
  await loadModel(page);
  await page.waitForFunction(
    () =>
      !document.querySelector("#run").disabled ||
      !document.querySelector("#error").hidden,
    null,
    { timeout: 200000 },
  );
  assert.equal(
    await page.locator("#error").isVisible(),
    false,
    await page.locator("#error").textContent(),
  );
  await navigate(page, "judge");
  assert.match(
    await page.locator("#image-hint").textContent(),
    /現在のモデルは画像に対応/,
  );
  ok("Public wllama loads LFM2.5-VL-3B with image capability");
  await page.locator("#state").fill("");
  const rows = page.locator(".criterion");
  await rows
    .nth(0)
    .locator('[data-field="instructions"]')
    .fill("Choose the dominant color of the attached image.");
  for (const [i, color] of ["red", "blue", "other"].entries()) {
    await rows.nth(0).locator('[data-field="label"]').nth(i).fill(color);
    await rows
      .nth(0)
      .locator('[data-field="description"]')
      .nth(i)
      .fill(`The image is predominantly ${color}.`);
  }
  await rows
    .nth(1)
    .locator('[data-field="instructions"]')
    .fill("The attached image is predominantly red.");
  await rows
    .nth(2)
    .locator('[data-field="instructions"]')
    .fill(
      "Rate how red the attached image is. Blue is level zero; red is level two.",
    );
  for (const [i, color] of ["blue", "purple", "red"].entries()) {
    await rows.nth(2).locator('[data-field="label"]').nth(i).fill(color);
    await rows
      .nth(2)
      .locator('[data-field="description"]')
      .nth(i)
      .fill(`The image is predominantly ${color}.`);
  }
  await context.setOffline(true);
  let network = 0;
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) network++;
  });
  for (const file of [red, blue]) {
    await page.locator("#images").setInputFiles(file);
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#image-previews img").length === 1 &&
        !document.querySelector("#run").disabled,
    );
    const result = await runEvaluation(page);
    report.results.push(result);
    assert.equal(result.diagnostics.supports_images, true);
    assert.equal(result.diagnostics.images[0].name, file.name);
    assert.ok(!("data" in result.diagnostics.images[0]));
    assert.deepEqual(
      Object.values(result.response.answers).map((answer) => answer.type),
      ["choice", "noul", "score"],
    );
    assert.equal(
      result.response.answers.department.choice,
      file.name.split(".")[0],
    );
    console.log(
      "RESULT",
      file.name,
      JSON.stringify(result.response.answers),
      result.diagnostics.evaluation_ms,
    );
    await page.screenshot({
      path: `.test-artifacts/vision-${file.name}.png`,
      fullPage: true,
    });
    await page.locator("#image-previews button").click();
  }
  assert.equal(network, 0);
  ok(
    "Image-only offline choice/noul/score inference and metadata export; choice changes with red versus blue pixels",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#images").setInputFiles([red, blue]);
  await page.waitForFunction(
    () => document.querySelectorAll("#image-previews img").length === 2,
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: ".test-artifacts/vision-mobile.png",
    fullPage: true,
  });
  ok("Multiple image previews fit mobile width");
  const multi = await runEvaluation(page);
  assert.equal(multi.diagnostics.images.length, 2);
  report.multipleImages = multi;
  ok("Two images reach all three criteria in real inference");
  await navigate(page, "models");
  await page
    .locator("#files")
    .setInputFiles(resolve(".models/SmolLM2-135M-Instruct.Q4_K_M.gguf"));
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
  await page.locator("#run").click();
  assert.match(
    await page.locator("#error").textContent(),
    /画像を読み取れません/,
  );
  assert.equal(await page.locator("#image-previews img").count(), 2);
  ok(
    "Switching to a text model rejects attached images rather than ignoring them",
  );
  assert.equal(network, 0);
  await writeFile(".test-artifacts/vision-console.json", JSON.stringify(logs));
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  await writeFile(
    ".test-artifacts/vision-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
