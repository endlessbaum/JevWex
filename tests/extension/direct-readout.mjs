import { chromium } from "playwright";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { navigate, runEvaluation, fillSingleCriterion } from "./ui-helpers.mjs";
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"],
});
const report = {
  browser: context.browser().version(),
  passed: [],
  runs: [],
  errors: [],
  requests: [],
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
  page.on("pageerror", (e) => report.errors.push(String(e)));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) report.requests.push(r.url());
  });
  page.on("console", async (message) => {
    if (message.text().startsWith("[JevWex raw response]")) {
      const r = await message.args()[2].jsonValue();
      report.lastRaw = r;
    }
  });
  await page.goto(`chrome-extension://${id}/jev.html`);
  await context.setOffline(true);
  async function load(file) {
    await navigate(page, "models");
    await page.locator("#files").setInputFiles(resolve(file));
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
    await navigate(page, "judge");
  }
  function verify(output, name) {
    assert.equal(
      output.diagnostics.readout_method,
      "candidate_token_logprobs_v1",
    );
    for (const row of output.diagnostics.model_outputs) {
      const tokens = row.candidate_tokens;
      assert.ok(tokens.every((t) => Number.isFinite(t.logprob)));
      const maximum = Math.max(...tokens.map((t) => t.logprob));
      const weights = tokens.map((t) => Math.exp(t.logprob - maximum));
      const sum = weights.reduce((a, b) => a + b, 0);
      tokens.forEach((t, i) =>
        assert.ok(Math.abs(t.probability - weights[i] / sum) < 1e-12),
      );
      assert.equal(row.output_tokens, 1);
      const answer = output.response.answers[row.question];
      if (answer.type === "noul")
        assert.equal(answer.noul, tokens[0].probability);
      else {
        assert.deepEqual(
          Object.values(answer.probabilities),
          tokens.map((t) => t.probability),
        );
        if (answer.type === "score")
          assert.ok(
            Math.abs(
              answer.score -
                tokens.reduce((s, t, i) => s + i * t.probability, 0),
            ) < 1e-12,
          );
      }
    }
    report.runs.push({ name, ...output });
    ok(name);
  }
  await load(".models/Qwen3-0.6B-Q4_K_M.gguf");
  await page.locator("#sample").click();
  verify(
    await runEvaluation(page),
    "Qwen3 Q4_K_M CPU: original routing sample, choice/score/noul from finite token logprobs",
  );
  const row = await fillSingleCriterion(page, {
    type: "choice",
    instructions: "Choose the matching number in the text.",
    text: "The number is 31.",
  });
  while ((await row.locator(".label-row").count()) < 32)
    await row.locator(".add-label").click();
  for (let i = 0; i < 32; i++) {
    await row.locator('[data-field="label"]').nth(i).fill(`number ${i}`);
    await row
      .locator('[data-field="description"]')
      .nth(i)
      .fill(`The number is ${i}.`);
  }
  verify(
    await runEvaluation(page),
    "32-choice readout includes every candidate",
  );
  await navigate(page, "hardware");
  await page.waitForFunction(
    () => !document.querySelector("#hardware-save").disabled,
  );
  if (await page.locator("#gpu-option").isEnabled()) {
    await page.locator("#hardware-device").selectOption("webgpu");
    await page.locator("#hardware-threads").selectOption("12");
    await page.locator("#hardware-save").click();
    await page.locator("#hardware-apply").click();
    await page.waitForFunction(
      () => !document.querySelector("#run").disabled,
      null,
      { timeout: 190000 },
    );
    await navigate(page, "judge");
    await page.locator("#sample").click();
    verify(
      await runEvaluation(page),
      "Qwen3 Q4_K_M GPU + 12 threads: routing sample",
    );
    await page
      .locator("#state")
      .fill("荷物がまだ届きません。配送状況を教えてください。");
    verify(
      await runEvaluation(page),
      "Qwen3 GPU: user-reported delivery-status text no longer generates numeric JSON",
    );
  } else report.notRun = ["GPU unavailable"];
  await load(".models/SmolLM2-135M-Instruct.Q4_K_M.gguf");
  await fillSingleCriterion(page);
  verify(
    await runEvaluation(page),
    "Switch model: SmolLM2 uses its own vocabulary and token probabilities",
  );
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.requests, []);
  ok("real MV3; offline inference; no page errors or added network access");
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await writeFile(
    ".test-artifacts/direct-readout-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
