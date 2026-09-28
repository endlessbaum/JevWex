import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
export async function navigate(page, destination) {
  await page.locator(`#nav-${destination}`).click();
  await page
    .locator(
      destination === "models"
        ? "#model-page"
        : destination === "hardware"
          ? "#hardware-page"
          : destination === "batch"
            ? "#batch-page"
            : "#judge-page",
    )
    .waitFor({ state: "visible" });
}
export async function fillSingleCriterion(
  page,
  {
    alias = "確認する項目",
    type = "noul",
    instructions = "The text mentions a cat.",
    text = "The cat sleeps.",
  } = {},
) {
  await navigate(page, "judge");
  while ((await page.locator("#criteria .criterion").count()) > 1)
    await page.locator("#criteria .remove-criterion").last().click();
  const row = page.locator("#criteria .criterion").first();
  await row.locator('[data-field="alias"]').fill(alias);
  await row.locator('[data-field="type"]').selectOption(type);
  await row.locator('[data-field="instructions"]').fill(instructions);
  await page.locator("#state").fill(text);
  return row;
}
export async function downloadResult(page) {
  const pending = page.waitForEvent("download");
  await page.locator("#download-result").click();
  const download = await pending;
  assert.match(download.suggestedFilename(), /\.json$/);
  return JSON.parse(await readFile(await download.path(), "utf8"));
}
export async function runEvaluation(page) {
  await page.locator("#run").click();
  await page.waitForFunction(
    () => !document.querySelector("#run").disabled,
    null,
    { timeout: 240000 },
  );
  assert.equal(
    await page.locator("#error").isVisible(),
    false,
    await page.locator("#error").textContent(),
  );
  return downloadResult(page);
}
