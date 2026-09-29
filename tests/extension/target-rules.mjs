import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"],
});
context.setDefaultTimeout(10000);
const report = {
  passed: [],
  errors: [],
  note: "判定入力・条件の対応をテスト用応答で検証。モデル精度は対象外。",
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
  const url = "https://huggingface.co/target-rules-test";
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `
    <html><head><title>対象と基準のセット</title><style>body{font:18px/1.6 system-ui;margin:24px}main{width:55%}li,section{padding:16px;margin:12px;border:1px solid #ccc}</style></head>
    <body><main id="main"><ul id="products"><li id="one">PRODUCT CAT <small id="ad-one">AD ONE</small></li><li id="two">PRODUCT DOG <small id="ad-two">AD TWO</small></li></ul><section id="reviews"><p id="review-text">REVIEW GOOD</p></section><aside id="other">UNRELATED</aside></main></body></html>`,
    }),
  );
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/index.html#sites`);
  const panel = await context.newPage();
  panel.on("pageerror", (e) => report.errors.push(String(e)));
  await panel.setViewportSize({ width: 390, height: 950 });
  await panel.goto(`chrome-extension://${id}/panel.html`);
  const source = await context.newPage();
  await source.goto(url);
  await source.bringToFront();
  await panel.waitForFunction(() =>
    document
      .querySelector("#source-preview")
      .textContent.includes("PRODUCT CAT"),
  );
  const sourceCDP = await context.newCDPSession(source);
  async function shadow(attribute, fn, arg) {
    const { root } = await sourceCDP.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (node) =>
      node.attributes?.includes(attribute)
        ? node.shadowRoots?.[0]
        : (node.children ?? []).map(find).find(Boolean);
    const target = find(root);
    assert.ok(target, attribute);
    const { object } = await sourceCDP.send("DOM.resolveNode", {
      backendNodeId: target.backendNodeId,
    });
    const response = await sourceCDP.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      awaitPromise: true,
      functionDeclaration: `function(arg){return (${fn})(this,arg)}`,
      arguments: [{ value: arg }],
    });
    await sourceCDP.send("Runtime.releaseObject", {
      objectId: object.objectId,
    });
    assert.equal(response.exceptionDetails, undefined);
    return response.result.value;
  }
  const edit = (fn, arg) => shadow("data-jev-scope-editor", fn, arg);
  const click = (text) =>
    edit(
      (root, text) =>
        [...root.querySelectorAll("button")]
          .find((b) => b.textContent === text)
          .click(),
      text,
    );
  const narrow = (label) =>
    edit((root, label) => {
      const row = root.querySelector(
        `input[aria-label="${label}を含める"]`,
      ).parentElement;
      [...row.querySelectorAll("button")]
        .find((b) => b.textContent === "この要素以下に絞る")
        .click();
    }, label);
  const localRules = () =>
    manager.evaluate(async () =>
      Object.entries(await chrome.storage.local.get(null))
        .filter(([key]) => key.startsWith("jev-site-rule:"))
        .map(([, value]) => value),
    );
  const begin = async (name, instructions) => {
    await panel.locator("#new-rule").click();
    await panel.locator("#create-condition").waitFor({ state: "visible" });
    await panel.locator("#create-name").fill(name);
    await panel
      .locator('#create-criteria [data-field="instructions"]')
      .fill(instructions);
    await panel.evaluate(() =>
      document.querySelector("#create-target-edit").click(),
    );
    await source.locator("[data-jev-scope-editor]").waitFor();
  };
  const applyTarget = async (label) => {
    await click("この対象を使う");
    await source
      .locator("[data-jev-scope-editor]")
      .waitFor({ state: "detached" });
    await panel.waitForFunction(
      (label) =>
        document.querySelector("#create-target").textContent.includes(label),
      label,
    );
  };
  const save = async () => {
    await panel.locator("#create-save").click();
    await panel.locator("#create-condition").waitFor({ state: "hidden" });
  };
  const openSaved = async (name) => {
    await panel
      .locator(".saved-rule")
      .filter({ hasText: name })
      .getByRole("button", { name: "対象・基準を編集" })
      .click();
    await panel.locator("#create-condition").waitFor({ state: "visible" });
  };

  await begin("A 商品", "Product criterion");
  await edit((root) => {
    const select = root.querySelector('[aria-label="ul#productsの判定方法"]');
    select.value = "individual";
    select.dispatchEvent(new Event("change"));
  });
  await edit((root) =>
    root.querySelector('input[aria-label="small#ad-oneを含める"]').click(),
  );
  await applyTarget("#products");
  assert.deepEqual(await localRules(), []);
  await save();
  await begin("B レビュー", "Review criterion");
  await narrow("section#reviews");
  await applyTarget("#reviews");
  await save();
  let rules = await localRules();
  const a = rules.find((r) => r.name === "A 商品"),
    b = rules.find((r) => r.name === "B レビュー");
  assert.equal(a.contentScope.root, "#products");
  assert.equal(a.contentScope.items, ":scope > li");
  assert.equal(a.contentScope.sharedExclude.length, 1);
  assert.equal(b.contentScope.root, "#reviews");
  assert.equal(b.contentScope.items, undefined);
  await panel.reload();
  await source.bringToFront();
  await panel.locator(".saved-rule").filter({ hasText: "#products" }).waitFor();
  assert.equal(await panel.locator(".saved-rule").count(), 2);
  ok(
    "two criteria on one URL persist with separate targets, per-item processing and shared exclusions; reload restores both pairs",
  );

  await openSaved("A 商品");
  await panel.evaluate(() =>
    document.querySelector("#create-target-edit").click(),
  );
  await source.locator("[data-jev-scope-editor]").waitFor();
  await click("自動選択に戻す");
  await narrow("section#reviews");
  await applyTarget("#reviews");
  assert.deepEqual(
    (await localRules()).find((r) => r.id === a.id),
    a,
  );
  panel.once("dialog", (dialog) => dialog.accept());
  await panel.locator("#create-close").click();
  assert.deepEqual(
    (await localRules()).find((r) => r.id === a.id),
    a,
  );
  ok(
    "applying a target only changes the unsaved draft; cancelling the pair editor leaves saved criteria and target intact",
  );

  await openSaved("B レビュー");
  await panel
    .locator('#create-criteria [data-field="instructions"]')
    .fill("Review criterion revised");
  await panel.evaluate(() =>
    document.querySelector("#create-target-edit").click(),
  );
  await source.locator("[data-jev-scope-editor]").waitFor();
  await narrow("p#review-text");
  await applyTarget("#review-text");
  assert.deepEqual(
    (await localRules()).find((r) => r.id === b.id),
    b,
  );
  await save();
  rules = await localRules();
  assert.equal(
    rules.find((r) => r.id === b.id).contentScope.root,
    "#review-text",
  );
  assert.equal(
    rules.find((r) => r.id === b.id).criteria[0].instructions,
    "Review criterion revised",
  );
  assert.deepEqual(
    rules.find((r) => r.id === a.id),
    a,
  );
  await mkdir(".test-artifacts", { recursive: true });
  await panel.screenshot({
    path: ".test-artifacts/target-rules-panel.png",
    fullPage: true,
  });
  ok(
    "saving an edited pair commits its target and criteria together without changing another pair",
  );

  await manager
    .locator(".site-rule")
    .filter({ hasText: "B レビュー" })
    .getByRole("button", { name: "編集", exact: true })
    .click();
  assert.match(
    await manager.locator("#site-target").textContent(),
    /#review-text/,
  );
  await manager
    .locator('#site-criteria [data-field="instructions"]')
    .fill("Management revision");
  await manager.evaluate(() =>
    document.querySelector("#site-target-edit").click(),
  );
  await source.locator("[data-jev-scope-editor]").waitFor();
  await click("親要素へ");
  await click("この対象を使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await manager.waitForFunction(() =>
    document.querySelector("#site-target").textContent.startsWith("#reviews ·"),
  );
  assert.equal(
    (await localRules()).find((r) => r.id === b.id).contentScope.root,
    "#review-text",
  );
  await manager.evaluate(() => document.querySelector("#site-save").click());
  await manager.waitForFunction(() =>
    document.querySelector("#site-status").textContent.includes("保存しました"),
  );
  assert.equal(
    (await localRules()).find((r) => r.id === b.id).contentScope.root,
    "#reviews",
  );
  assert.equal(
    (await localRules()).find((r) => r.id === b.id).criteria[0].instructions,
    "Management revision",
  );
  ok(
    "management edits the target visually and saves it with criteria while preserving other pairs",
  );

  await manager.evaluate(async (url) => {
    await chrome.storage.local.set({
      [`jev-content-scope:${url}`]: { root: "#missing-draft", exclude: [] },
    });
    globalThis.requests = [];
    const channel = (globalThis.observer = new BroadcastChannel(
      "jev-web-page-judge-v1",
    ));
    channel.onmessage = async ({ data }) => {
      if (data.type === "hello")
        channel.postMessage({
          type: "status",
          status: {
            id: "pair-observer",
            ready: true,
            model: "observer",
            phase: "ready",
          },
        });
      if (data.type !== "evaluate") return;
      const rule = (
        await chrome.storage.local.get(`jev-site-rule:${data.request.ruleId}`)
      )[`jev-site-rule:${data.request.ruleId}`];
      globalThis.requests.push({
        ruleId: rule.id,
        text: data.request.text,
        instructions: rule.criteria[0].instructions,
      });
      channel.postMessage({
        type: "result",
        ...data.request,
        result: {
          evaluation: {
            response: { answers: { result: { type: "noul", noul: 0.5 } } },
          },
          presentation: { result: { alias: "test", labels: [] } },
        },
      });
    };
  }, url);
  await panel.waitForFunction(() =>
    document.querySelector("#error").textContent.includes("保存した本文範囲"),
  );
  assert.equal(await panel.getByRole("switch").count(), 2);
  await panel.close();
  await source.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#other"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  const tabId = await manager.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
    url,
  );
  const run = async () => {
    const response = await manager.evaluate(
      (tabId) =>
        chrome.runtime.sendMessage({
          type: "jev-run-page",
          tabId,
          mode: "auto",
        }),
      tabId,
    );
    assert.ok(response.jobId, JSON.stringify(response));
    for (let n = 0; n < 200; n++) {
      const state = await manager.evaluate(
        async (tabId) =>
          (await chrome.storage.session.get(`jev-page-job:${tabId}`))[
            `jev-page-job:${tabId}`
          ],
        tabId,
      );
      if (state?.jobId === response.jobId && state.phase !== "running")
        return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("pair execution did not finish");
  };
  const state = await run();
  assert.equal(state.phase, "complete");
  assert.doesNotMatch(state.message, /失敗/);
  assert.deepEqual(await manager.evaluate(() => globalThis.requests), [
    { ruleId: a.id, text: "PRODUCT CAT", instructions: "Product criterion" },
    { ruleId: a.id, text: "PRODUCT DOG", instructions: "Product criterion" },
    { ruleId: b.id, text: "REVIEW GOOD", instructions: "Management revision" },
  ]);
  ok(
    "without the panel, each enabled criterion receives only its own saved target; a broken new-rule draft and incidental selection cannot override it",
  );
  await source.evaluate(() => document.querySelector("#products").remove());
  await manager.evaluate(() => {
    globalThis.requests = [];
  });
  const partial = await run();
  assert.equal(partial.phase, "complete");
  assert.match(partial.message, /失敗 1件/);
  assert.deepEqual(
    await manager.evaluate(() => globalThis.requests.map((r) => r.text)),
    ["REVIEW GOOD"],
  );
  const overlay = await shadow(
    "data-jev-overlay",
    (root) => root.querySelector(".box").innerText,
  );
  assert.match(overlay, /A 商品/);
  assert.match(overlay, /保存した本文範囲/);
  assert.match(overlay, /B レビュー/);
  ok(
    "a missing target reports an error for that pair and remaining pairs still run against their own targets",
  );
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.errors.push(String(error));
  throw error;
} finally {
  await writeFile(
    "docs/target-rules-test-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await context.close();
}
