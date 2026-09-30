import { loadModel } from "./ui-helpers.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir(".test-artifacts", { recursive: true });
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: process.env.JEV_TEST_HEADED !== "1",
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"],
});
const report = {
  passed: [],
  errors: [],
  notRun: [
    "OSのキー操作によるChromeショートカットイベント・activeTab付与（同じ実行処理をruntimeメッセージから検証）",
    "ネイティブサイドパネル内の操作（専用panel.htmlを通常タブで検証）",
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
  const base = `chrome-extension://${id}`;
  const app = await context.newPage();
  app.on("pageerror", (e) => report.errors.push(String(e)));
  await app.goto(base + "/index.html#sites");
  await app.locator("#sites-page").waitFor({ state: "visible" });
  await app.locator("#site-new").click();
  await app.locator("#site-name").fill("記事の動物");
  const sourceUrl = "https://huggingface.co/jev-test/article?version=1";
  await app.locator("#site-url").fill(sourceUrl + "#heading");
  const criterion = app.locator("#site-criteria .criterion");
  await criterion.locator('[data-field="alias"]').fill("猫について");
  await criterion.locator('[data-field="type"]').selectOption("noul");
  await criterion
    .locator('[data-field="instructions"]')
    .fill("The text mentions a cat.");
  await app.locator("#site-save").click();
  await app.waitForFunction(() =>
    document.querySelector("#site-status").textContent.includes("保存しました"),
  );
  await app.reload();
  await app.locator(".site-rule").waitFor();
  ok("management retains independently saved URL rules");
  await context.route("https://huggingface.co/jev-test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><head><meta charset="utf-8"><title>動物の記事</title><style>body{font:20px sans-serif;background:#e6f1ea;padding:40px}button{display:none}h2{color:red}</style></head><body><h1>Animal news</h1><p id="article">The cat sleeps on the sofa.</p><p hidden>HIDDEN CONTENT</p><input type="password" value="SECRET PASSWORD"><script>var secret="SCRIPT SECRET"</script></body></html>',
    }),
  );
  const source = await context.newPage();
  await source.goto(sourceUrl);
  const sourceCDP = await context.newCDPSession(source);
  async function overlay(action = "text") {
    const { root } = await sourceCDP.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (node) => {
      if (node.attributes?.includes("data-jev-overlay"))
        return node.shadowRoots?.[0];
      for (const child of node.children ?? []) {
        const found = find(child);
        if (found) return found;
      }
    };
    const shadow = find(root);
    if (!shadow) return null;
    const { object } = await sourceCDP.send("DOM.resolveNode", {
      backendNodeId: shadow.backendNodeId,
    });
    const { result } = await sourceCDP.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration:
        action === "close"
          ? 'function(){this.querySelector(".close").click();return true}'
          : action === "cancel"
            ? 'function(){Array.from(this.querySelectorAll("button")).find(b=>b.textContent==="中止").click();return true}'
            : 'function(){return this.querySelector(".box").innerText}',
    });
    await sourceCDP.send("Runtime.releaseObject", {
      objectId: object.objectId,
    });
    return result.value;
  }
  let panel = await context.newPage();
  panel.on("pageerror", (e) => report.errors.push(String(e)));
  await panel.setViewportSize({ width: 390, height: 950 });
  await panel.goto(base + "/panel.html");
  assert.equal(
    await panel
      .locator("#model-page, #batch-page, #hardware-page, #result-section")
      .count(),
    0,
  );
  const refresh = async () => {
    await source.bringToFront();
    await panel.evaluate(() =>
      document.querySelector("#source-refresh").click(),
    );
    await panel.waitForFunction(
      () => !document.querySelector("#source-refresh").disabled,
    );
  };
  await refresh();
  assert.equal(await panel.locator("#source-url").textContent(), sourceUrl);
  assert.match(
    await panel.locator("#source-preview").textContent(),
    /The cat sleeps/,
  );
  assert.doesNotMatch(
    await panel.locator("#source-preview").textContent(),
    /HIDDEN CONTENT|SECRET PASSWORD|SCRIPT SECRET/,
  );
  const firstSwitch = panel.getByRole("switch", {
    name: "記事の動物をオンにする",
  });
  assert.equal(await firstSwitch.isChecked(), true);
  await firstSwitch.uncheck();
  await app.waitForFunction(() =>
    document.querySelector(".site-rule").textContent.includes("無効"),
  );
  assert.equal(await firstSwitch.isVisible(), true);
  await panel.reload();
  await refresh();
  assert.equal(await firstSwitch.isChecked(), false);
  await firstSwitch.check();
  await app.waitForFunction(() =>
    document.querySelector(".site-rule").textContent.includes("有効"),
  );
  ok(
    "URL-matching conditions remain visible when off; switches persist and synchronize with management",
  );
  await panel.locator("#new-rule").click();
  assert.equal(await panel.locator("#create-url").inputValue(), sourceUrl);
  await panel.locator("#create-save").click();
  await panel.locator("#create-error").waitFor({ state: "visible" });
  assert.equal(await panel.locator("#create-error").isVisible(), true);
  await panel.locator("#create-name").fill("<b>場所の確認</b>");
  await panel
    .locator('#create-criteria [data-field="alias"]')
    .fill("ソファについて");
  await panel
    .locator('#create-criteria [data-field="instructions"]')
    .fill("The text mentions a sofa.");
  await panel.screenshot({
    path: ".test-artifacts/sites-create.png",
    fullPage: true,
  });
  await panel.locator("#create-save").click();
  await panel.locator("#create-condition").waitFor({ state: "hidden" });
  await app.waitForFunction(
    () => document.querySelectorAll(".site-rule").length === 2,
  );
  assert.equal(await panel.getByRole("switch").count(), 2);
  assert.equal(await panel.getByRole("switch").last().isChecked(), true);
  assert.equal(await panel.locator("#source-rules b").count(), 0);
  assert.equal(
    await panel.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  ok(
    "panel creates validated criteria for the captured URL, saved on and shared with management; names render as text",
  );
  await source.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#article"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await refresh();
  assert.equal(await panel.locator("#source-mode").count(), 0);
  assert.equal(await panel.locator("#scope-edit").count(), 0);
  assert.match(
    await panel.locator("#source-preview").textContent(),
    /Animal news/,
  );
  await panel.locator("#open-models").click();
  await app.locator("#model-page").waitFor({ state: "visible" });
  const tabId = await app.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
    sourceUrl,
  );
  assert.equal(typeof tabId, "number");
  const commands = await app.evaluate(() => chrome.commands.getAll());
  assert.ok(commands.some((command) => command.name === "evaluate-page"));
  const waitForJob = async (jobId, phase) => {
    assert.ok(jobId, "execution must return a job ID");
    for (let n = 0; n < 600; n++) {
      const state = await app.evaluate(
        async (tabId) =>
          (await chrome.storage.session.get(`jev-page-job:${tabId}`))[
            `jev-page-job:${tabId}`
          ],
        tabId,
      );
      if (
        state?.jobId === jobId &&
        (phase ? state.phase === phase : state.phase !== "running")
      )
        return state;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `Timed out waiting for job ${jobId} (${phase ?? "terminal"})`,
    );
  };
  const terminal = (jobId) => waitForJob(jobId);
  const startWithoutPanel = async () =>
    app.evaluate(
      (tabId) =>
        chrome.runtime.sendMessage({
          type: "jev-run-page",
          tabId,
          mode: "auto",
        }),
      tabId,
    );
  if (process.env.JEV_TEST_MODEL) {
    await app.locator("#files").setInputFiles(process.env.JEV_TEST_MODEL);
    await loadModel(app);
    // The panel follows the active tab; return from management to the article.
    await refresh();
    await panel.waitForFunction(
      () => !document.querySelector("#run").disabled,
      null,
      { timeout: 120000 },
    );
    const originalInput = await app.locator("#state").inputValue();
    await panel.locator("#run").click();
    await panel.waitForFunction(
      () =>
        document
          .querySelector("#progress")
          .textContent.includes("2件の条件で判定しました"),
      null,
      { timeout: 120000 },
    );
    assert.match(await overlay(), /記事の動物/);
    assert.match(await overlay(), /<b>場所の確認<\/b>/);
    assert.match(await overlay(), /当てはまり/);
    assert.equal(
      await source.evaluate(
        () => document.querySelector("[data-jev-overlay]").shadowRoot,
      ),
      null,
    );
    assert.equal(await app.locator("#state").inputValue(), originalInput);
    assert.equal(await app.locator("#results .answer").count(), 0);
    ok(
      "all on conditions run sequentially on the management model; only the Web-page overlay shows results",
    );
    await source.screenshot({
      path: ".test-artifacts/sites-overlay.png",
      fullPage: true,
    });
    await refresh();
    assert.doesNotMatch(
      await panel.locator("#source-preview").textContent(),
      /JevWex|当てはまり/,
    );
    ok("overlay contents are excluded from subsequent page capture");
    await panel
      .getByRole("switch", { name: "<b>場所の確認</b>をオンにする" })
      .uncheck();
    await panel.waitForFunction(
      () =>
        document.querySelectorAll("#source-rules input:checked").length === 1,
    );
    await panel.screenshot({
      path: ".test-artifacts/sites-panel.png",
      fullPage: true,
    });
    await panel.close();
    const before = context.pages().length;
    const response = await startWithoutPanel();
    assert.equal((await terminal(response.jobId)).phase, "complete");
    assert.match(await overlay(), /1件の条件で判定しました/);
    assert.doesNotMatch(await overlay(), /場所の確認/);
    assert.equal(context.pages().length, before);
    assert.equal(
      context.pages().some((page) => page.url().includes("panel.html")),
      false,
    );
    ok(
      "the shortcut execution path works with no panel document and ignores off conditions without opening a panel",
    );
    const cancelled = await startWithoutPanel();
    await source.locator("[data-jev-overlay]").waitFor();
    await waitForJob(cancelled.jobId, "running");
    await overlay("cancel");
    assert.equal((await terminal(cancelled.jobId)).phase, "cancelled");
    ok("overlay cancellation works independently of the panel");
    await overlay("close");
    await source.locator("[data-jev-overlay]").waitFor({ state: "detached" });
    const moving = await startWithoutPanel();
    await waitForJob(moving.jobId, "running");
    await source.evaluate(() => history.pushState({}, "", "/jev-test/other"));
    assert.equal((await terminal(moving.jobId)).phase, "cancelled");
    await source.locator("[data-jev-overlay]").waitFor({ state: "detached" });
    ok("SPA navigation cancels work and removes the old page overlay");
    await source.goto(sourceUrl);
    const navigating = await startWithoutPanel();
    await waitForJob(navigating.jobId, "running");
    await source.goto("https://huggingface.co/jev-test/replaced");
    assert.equal((await terminal(navigating.jobId)).phase, "cancelled");
    assert.equal(await source.locator("[data-jev-overlay]").count(), 0);
    ok(
      "full navigation also persists a terminal state without injecting into the replacement document",
    );
    await source.goto(sourceUrl);
  } else {
    report.notRun.push("実モデル推論（JEV_TEST_MODEL未指定）");
    await panel.close();
  }
  await app.evaluate(async () => {
    const data = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(data))
      if (key.startsWith("jev-site-rule:"))
        await chrome.storage.local.set({ [key]: { ...value, enabled: false } });
  });
  const noRules = await startWithoutPanel();
  assert.equal((await terminal(noRules.jobId)).phase, "error");
  assert.match(await overlay(), /オンになっている判定条件がありません/);
  ok("all-off produces a useful error in the overlay without inference");
  await source.goto("about:blank");
  const restricted = await startWithoutPanel();
  assert.equal((await terminal(restricted.jobId)).phase, "error");
  assert.equal(
    await app.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId),
    "!",
  );
  ok(
    "restricted pages report failure with an action badge instead of opening a panel",
  );
  assert.deepEqual(report.errors, []);
} catch (e) {
  report.failure = String(e);
  throw e;
} finally {
  await writeFile(
    "docs/sites-test-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await context.close();
}
