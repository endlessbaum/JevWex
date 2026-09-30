import { loadModel } from "./ui-helpers.mjs";
import { openStandaloneScopeEditor } from "./scope-editor-helper.mjs";
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
  note: "入力の分離・失敗・中止の確認にはテスト用の判定応答を使用。JEV_TEST_MODEL指定時は実モデルによる3件の判定も別に検証。",
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
  const url = "https://huggingface.co/repeated-test";
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><head><title>項目別の判定</title><style>body{font:18px/1.6 system-ui;background:#f0f5f2;margin:30px}main{width:62%}ul{padding:0;list-style:none}.card{background:white;border:1px solid #cbd9d0;border-radius:8px;padding:18px;margin:12px 0}small{color:#777}</style></head><body><header>GLOBAL HEADER</header><main><h1>商品リスト</h1><ul id="list"><li>LIST HEADER</li><li class="card" id="alpha">ALPHA cat one<small id="meta">OMIT THIS</small><ul><li>nested A</li><li>nested B</li></ul></li><li class="card" id="beta">BETA dog two</li><li class="card" id="gamma">GAMMA bird three</li><li class="card" hidden>HIDDEN CARD</li><li class="card"></li></ul></main></body></html>`,
    }),
  );
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/panel.html`);
  panel.on("pageerror", (e) => report.errors.push(String(e)));
  const source = await context.newPage();
  await source.goto(url);
  await source.bringToFront();
  await panel.waitForFunction(() =>
    document.querySelector("#source-preview").textContent.includes("ALPHA"),
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
    const result = await sourceCDP.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      awaitPromise: true,
      functionDeclaration: `function(arg){return (${fn})(this,arg)}`,
      arguments: [{ value: arg }],
    });
    await sourceCDP.send("Runtime.releaseObject", {
      objectId: object.objectId,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
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
  await openStandaloneScopeEditor(panel);
  await source.locator("[data-jev-scope-editor]").waitFor();
  await edit((root) =>
    root.querySelector('input[aria-label="small#metaを含める"]').click(),
  );
  await edit((root) => {
    const select = root.querySelector('[aria-label="ul#listの判定方法"]');
    select.value = "individual";
    select.dispatchEvent(new Event("change"));
  });
  assert.match(
    await edit(
      (root) => root.querySelector("[data-scope-summary]").textContent,
    ),
    /3件を個別判定/,
  );
  assert.equal(
    await edit((root) => root.querySelectorAll(".outline.item").length),
    3,
  );
  const preview = await edit((root) => root.querySelector("pre").textContent);
  assert.match(preview, /【1件目/);
  assert.match(preview, /【3件目/);
  assert.doesNotMatch(preview, /GLOBAL|LIST HEADER|OMIT THIS|HIDDEN CARD/);
  await mkdir(".test-artifacts", { recursive: true });
  await source.screenshot({ path: ".test-artifacts/repeated-editor.png" });
  await click("新しい条件の対象に使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel.waitForFunction(() =>
    document
      .querySelector("#scope-summary")
      .textContent.includes("3件をそれぞれ"),
  );
  await source.reload();
  await panel.waitForFunction(() =>
    document
      .querySelector("#scope-summary")
      .textContent.includes("3件をそれぞれ"),
  );
  ok(
    "sibling cards are numbered separately; nested lists, hidden/empty rows and excluded children are handled; settings persist",
  );

  await openStandaloneScopeEditor(panel);
  await source.locator("[data-jev-scope-editor]").waitFor();
  assert.equal(
    await edit(
      (root) => root.querySelector('[aria-label="ul#listの判定方法"]').value,
    ),
    "individual",
  );
  assert.equal(
    await edit((root) =>
      [...root.querySelectorAll("button")].some(
        (button) => button.textContent === "同じ並びを1件ずつ",
      ),
    ),
    false,
  );
  await edit((root) => {
    const select = root.querySelector('[aria-label="ul#listの1件分の子要素"]');
    select.value = ":scope > li";
    select.dispatchEvent(new Event("change"));
  });
  assert.equal(
    await edit((root) => root.querySelectorAll(".outline.item").length),
    4,
  );
  await edit((root) => {
    const select = root.querySelector('[aria-label="ul#listの1件分の子要素"]');
    select.value = ":scope > li.card";
    select.dispatchEvent(new Event("change"));
  });
  await edit((root) => {
    const select = root.querySelector('[aria-label="ul#listの判定方法"]');
    select.value = "combined";
    select.dispatchEvent(new Event("change"));
  });
  assert.equal(
    await edit((root) => root.querySelectorAll(".outline.item").length),
    0,
  );
  const combined = await edit((root) => root.querySelector("pre").textContent);
  assert.match(combined, /LIST HEADER/);
  assert.doesNotMatch(combined, /【1件目|OMIT THIS/);
  await click("新しい条件の対象に使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  const saved = await panel.evaluate(
    async (url) =>
      (await chrome.storage.local.get(`jev-content-scope:${url}`))[
        `jev-content-scope:${url}`
      ],
    url,
  );
  assert.equal(saved.root, "#list");
  assert.equal(saved.items, undefined);
  await source.reload();
  await panel.waitForFunction(() =>
    document
      .querySelector("#source-preview")
      .textContent.includes("LIST HEADER"),
  );
  await openStandaloneScopeEditor(panel);
  await source.locator("[data-jev-scope-editor]").waitFor();
  assert.equal(
    await edit(
      (root) => root.querySelector('[aria-label="ul#listの判定方法"]').value,
    ),
    "combined",
  );
  await edit((root) => {
    const select = root.querySelector('[aria-label="ul#listの判定方法"]');
    select.value = "individual";
    select.dispatchEvent(new Event("change"));
  });
  await click("新しい条件の対象に使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel.waitForFunction(() =>
    document
      .querySelector("#scope-summary")
      .textContent.includes("3件をそれぞれ"),
  );
  ok(
    "parent controls switch between individual and combined processing, preserve exclusions, allow choosing the child group and restore the saved mode after reload",
  );

  const tabId = await panel.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
    url,
  );
  await panel.evaluate(async (url) => {
    await chrome.storage.local.set({
      "jev-site-rule:repeated": {
        id: "repeated",
        name: "動物の判定",
        url,
        scope: "exact",
        enabled: true,
        criteria: [
          {
            id: "cat",
            alias: "cat",
            type: "noul",
            instructions: "A cat is mentioned",
            labels: [],
          },
        ],
      },
    });
    globalThis.requests = [];
    globalThis.testMode = "errors";
    const channel = (globalThis.testChannel = new BroadcastChannel(
      "jev-web-page-judge-v1",
    ));
    channel.onmessage = ({ data }) => {
      if (data.type === "hello")
        channel.postMessage({
          type: "status",
          status: {
            id: "repeated-manager",
            ready: true,
            model: "test",
            phase: "ready",
          },
        });
      if (data.type !== "evaluate") return;
      globalThis.requests.push(data.request.text);
      if (globalThis.testMode === "pause" && globalThis.requests.length > 1)
        return;
      channel.postMessage({
        type: "result",
        ...data.request,
        ...(globalThis.testMode === "errors" &&
        data.request.text.includes("BETA")
          ? { error: "この項目はコンテキスト上限を超えました（テスト）" }
          : {
              result: {
                evaluation: {
                  response: { answers: { cat: { type: "noul", noul: 0.75 } } },
                },
                presentation: { cat: { alias: "猫について", labels: [] } },
              },
            }),
      });
    };
  }, url);
  const start = () =>
    panel.evaluate(
      (tabId) =>
        chrome.runtime.sendMessage({
          type: "jev-run-page",
          tabId,
          mode: "auto",
        }),
      tabId,
    );
  const waitJob = async (jobId, phase) => {
    for (let n = 0; n < 2400; n++) {
      const state = await panel.evaluate(
        async (tabId) =>
          (await chrome.storage.session.get(`jev-page-job:${tabId}`))[
            `jev-page-job:${tabId}`
          ],
        tabId,
      );
      if (state?.jobId === jobId && state.phase === phase) return state;
      if (state?.jobId === jobId && state.phase !== "running")
        throw new Error(`Unexpected job state: ${JSON.stringify(state)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("job timeout");
  };
  const first = await start();
  const completed = await waitJob(first.jobId, "complete");
  assert.match(completed.message, /3件を個別/);
  assert.match(completed.message, /失敗 1件/);
  const requests = await panel.evaluate(() => globalThis.requests);
  assert.equal(requests.length, 3);
  for (const [index, name] of ["ALPHA", "BETA", "GAMMA"].entries()) {
    assert.match(requests[index], new RegExp(name));
    for (const other of ["ALPHA", "BETA", "GAMMA"].filter(
      (value) => value !== name,
    ))
      assert.doesNotMatch(requests[index], new RegExp(other));
  }
  assert.doesNotMatch(requests.join(""), /OMIT THIS|LIST HEADER|HIDDEN CARD/);
  const results = await shadow(
    "data-jev-overlay",
    (root) => root.querySelector(".box").innerText,
  );
  assert.match(results, /1件目：ALPHA/);
  assert.match(results, /2件目：BETA/);
  assert.match(results, /3件目：GAMMA/);
  assert.match(results, /コンテキスト上限/);
  await source.screenshot({ path: ".test-artifacts/repeated-results.png" });
  ok(
    "each item reaches inference alone; a failed item is shown separately and later items still complete",
  );

  await panel.evaluate(() => {
    globalThis.requests = [];
    globalThis.testMode = "pause";
  });
  const second = await start();
  await panel.waitForFunction(() => globalThis.requests.length === 2);
  await shadow("data-jev-overlay", (root) =>
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "中止")
      .click(),
  );
  await waitJob(second.jobId, "cancelled");
  assert.equal(await panel.evaluate(() => globalThis.requests.length), 2);
  assert.match(
    await shadow(
      "data-jev-overlay",
      (root) => root.querySelector(".box").innerText,
    ),
    /1件目：ALPHA/,
  );
  ok(
    "cancelling during item two preserves item one's result and never sends item three",
  );

  const originalItems = await source.locator("#list").innerHTML();
  await source.evaluate(() => {
    const list = document.querySelector("#list");
    list.replaceChildren();
    for (let index = 1; index <= 103; index++) {
      const item = document.createElement("li");
      item.className = "card";
      item.id = `row-${index}`;
      item.textContent = `ROW ${index} ${"x".repeat(5000)}`;
      list.append(item);
    }
  });
  await panel.evaluate(() => document.querySelector("#source-refresh").click());
  await panel.waitForFunction(() =>
    document
      .querySelector("#scope-summary")
      .textContent.includes("103件をそれぞれ"),
  );
  await openStandaloneScopeEditor(panel);
  await source.locator("[data-jev-scope-editor]").waitFor();
  assert.equal(
    await edit((root) => root.querySelectorAll(".outline.item").length),
    103,
  );
  await click("新しい条件の対象に使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel.evaluate(() => {
    globalThis.requests = [];
    globalThis.testMode = "success";
  });
  const large = await start();
  const largeState = await waitJob(large.jobId, "complete");
  assert.match(largeState.message, /103件を個別/);
  assert.doesNotMatch(largeState.message, /失敗/);
  const largeInputs = await panel.evaluate(() => globalThis.requests);
  assert.equal(largeInputs.length, 103);
  assert.ok(largeInputs.reduce((sum, text) => sum + text.length, 0) > 500000);
  for (const [index, text] of largeInputs.entries())
    assert.equal(text, `ROW ${index + 1} ${"x".repeat(5000)}`);
  assert.match(
    await shadow(
      "data-jev-overlay",
      (root) => root.querySelector(".box").innerText,
    ),
    /103件目：ROW 103/,
  );
  await source.evaluate((html) => {
    document.querySelector("#list").innerHTML = html;
  }, originalItems);
  await panel.evaluate(() => document.querySelector("#source-refresh").click());
  await panel.waitForFunction(() =>
    document
      .querySelector("#scope-summary")
      .textContent.includes("3件をそれぞれ"),
  );
  ok(
    "103 items totaling over 500,000 characters can be captured, edited and saved; every item reaches inference independently and the final item result is shown",
  );

  if (process.env.JEV_TEST_MODEL) {
    await panel.evaluate(() => {
      globalThis.testChannel.postMessage({
        type: "closed",
        managerId: "repeated-manager",
      });
      globalThis.testChannel.close();
    });
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${id}/index.html#models`);
    await manager.locator("#files").setInputFiles(process.env.JEV_TEST_MODEL);
    await loadModel(manager);
    await source.bringToFront();
    await panel.waitForFunction(
      () => !document.querySelector("#run").disabled,
      null,
      { timeout: 120000 },
    );
    const real = await start();
    const state = await waitJob(real.jobId, "complete");
    assert.doesNotMatch(state.message, /失敗/);
    const result = await shadow("data-jev-overlay", (root) => ({
      text: root.querySelector(".box").innerText,
      values: root.querySelectorAll(".value").length,
    }));
    assert.equal(result.values, 3);
    assert.match(result.text, /1件目：ALPHA/);
    assert.match(result.text, /3件目：GAMMA/);
    await source.screenshot({
      path: ".test-artifacts/repeated-real-results.png",
    });
    ok(
      "a real local model evaluates all three items separately and renders three attributed results",
    );
  }

  await source.evaluate(() =>
    document
      .querySelectorAll(".card")
      .forEach((el) => el.classList.remove("card")),
  );
  await panel.evaluate(() => document.querySelector("#source-refresh").click());
  await panel.waitForFunction(() =>
    document
      .querySelector("#error")
      .textContent.includes("1件分の要素が見つかりません"),
  );
  await panel.evaluate(() => {
    globalThis.requests = [];
    globalThis.testMode = "success";
  });
  const missing = await start();
  const missingState = await waitJob(missing.jobId, "complete");
  assert.match(missingState.message, /失敗 1件/);
  assert.equal(await panel.evaluate(() => globalThis.requests.length), 0);
  ok(
    "a missing repeated-item pattern blocks evaluation instead of reverting to a merged page",
  );

  await source.evaluate(() => {
    const cards = document.createElement("div");
    cards.id = "cards";
    cards.innerHTML =
      '<div class="record">同じ本文</div><div class="record">同じ本文</div>';
    document.querySelector("#list").replaceWith(cards);
  });
  await openStandaloneScopeEditor(panel);
  await source.locator("[data-jev-scope-editor]").waitFor();
  await click("自動選択に戻す");
  await click("新しい条件の対象に使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel.waitForFunction(() =>
    document.querySelector("#source-preview").textContent.includes("同じ本文"),
  );
  await openStandaloneScopeEditor(panel);
  await source.locator("[data-jev-scope-editor]").waitFor();
  await edit((root) => {
    const select = root.querySelector('[aria-label="div#cardsの判定方法"]');
    select.value = "individual";
    select.dispatchEvent(new Event("change"));
  });
  assert.match(
    await edit(
      (root) => root.querySelector("[data-scope-summary]").textContent,
    ),
    /2件を個別/,
  );
  await click("新しい条件の対象に使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel.waitForFunction(() =>
    document
      .querySelector("#scope-summary")
      .textContent.includes("2件をそれぞれ"),
  );
  await source.evaluate(() => {
    const card = document.createElement("div");
    card.className = "record";
    card.textContent = "新しい本文";
    document.querySelector("#cards").append(card);
  });
  await panel.evaluate(() => document.querySelector("#source-refresh").click());
  await panel.waitForFunction(() =>
    document
      .querySelector("#scope-summary")
      .textContent.includes("3件をそれぞれ"),
  );
  ok(
    "div-card candidates work too; equal text is not deduplicated and newly loaded siblings are captured on refresh",
  );
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.errors.push(String(error));
  throw error;
} finally {
  await writeFile(
    "docs/repeated-test-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await context.close();
}
