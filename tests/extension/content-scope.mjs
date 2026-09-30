import { openStandaloneScopeEditor } from "./scope-editor-helper.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: process.env.JEV_TEST_HEADED !== "1",
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"],
});
context.setDefaultTimeout(10000);
const report = { passed: [], errors: [] };
const ok = (name) => {
  report.passed.push(name);
  console.log("PASS", name);
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const url = "https://huggingface.co/scope-test/article";
  await context.route("https://huggingface.co/scope-test/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><head><title>本文の範囲を選ぶテスト</title><style>body{font:18px/1.7 system-ui;background:#f1f5f2;margin:30px}main{width:60%;padding:24px;background:white}aside{padding:15px;background:#fbecea}h1{font-size:28px}header{margin-bottom:20px}section{padding:12px}</style></head><body><header>GLOBAL NAVIGATION</header><main id="main"><article id="article"><h1>街の動物たち</h1><section id="story"><p>The cat sleeps on the sofa.</p><p>今日は公園に猫がいました。</p><p hidden>HIDDEN SECRET</p></section><aside id="related"><h2>関連記事</h2><p>UNWANTED AD CONTENT</p><a href="/scope-test/unwanted">広告を開く</a></aside></article><section id="comments"><p>UNWANTED COMMENTS</p></section></main><footer>GLOBAL FOOTER</footer></body></html>`,
    }),
  );
  const panel = await context.newPage();
  panel.on("pageerror", (e) => report.errors.push(String(e)));
  await panel.goto(`chrome-extension://${id}/panel.html`);
  const source = await context.newPage();
  await source.goto(url);
  await source.bringToFront();
  await panel.waitForFunction(() =>
    document.querySelector("#source-preview").textContent.includes("The cat"),
  );
  assert.doesNotMatch(
    await panel.locator("#source-preview").textContent(),
    /GLOBAL|HIDDEN/,
  );
  assert.match(
    await panel.locator("#scope-summary").textContent(),
    /main#main/,
  );
  ok(
    "automatic main-content capture excludes site navigation, footer and hidden text",
  );

  const sourceCDP = await context.newCDPSession(source);
  async function edit(fn, arg) {
    const { root } = await sourceCDP.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (node) =>
      node.attributes?.includes("data-jev-scope-editor")
        ? node.shadowRoots?.[0]
        : (node.children ?? []).map(find).find(Boolean);
    const shadow = find(root);
    assert.ok(shadow, "scope editor exists");
    const { object } = await sourceCDP.send("DOM.resolveNode", {
      backendNodeId: shadow.backendNodeId,
    });
    const { result, exceptionDetails } = await sourceCDP.send(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        returnByValue: true,
        awaitPromise: true,
        functionDeclaration: `function(arg) { return (${fn})(this, arg); }`,
        arguments: [{ value: arg }],
      },
    );
    await sourceCDP.send("Runtime.releaseObject", {
      objectId: object.objectId,
    });
    assert.equal(exceptionDetails, undefined);
    return result.value;
  }
  const click = (text) =>
    edit(
      (root, text) =>
        [...root.querySelectorAll("button")]
          .find((b) => b.textContent === text)
          .click(),
      text,
    );
  const open = async () => {
    await openStandaloneScopeEditor(panel);
    await source.locator("[data-jev-scope-editor]").waitFor();
  };
  await open();
  assert.equal(
    await edit((root) => {
      const structure = root.querySelector("[data-scope-structure]");
      return (
        [...structure.querySelectorAll("button")].some(
          (button) => button.textContent === "親要素へ",
        ) &&
        structure.getBoundingClientRect().top <
          root.querySelector(".options").getBoundingClientRect().top &&
        !root.querySelector(".help").open &&
        ![...root.querySelectorAll("button")].some((button) =>
          button.textContent.includes("除外を選ぶ"),
        )
      );
    }),
    true,
  );
  const treeScroll = await edit((root) => {
    root.querySelectorAll(".tree details").forEach((details) => {
      details.open = true;
    });
    const tree = root.querySelector(".tree");
    tree.scrollTop = 80;
    return tree.scrollTop;
  });
  // The whole label is a toggle; it must not collapse the surrounding tree row.
  await edit((root) =>
    root
      .querySelector('input[aria-label="aside#relatedを含める"]')
      .closest("label")
      .click(),
  );
  assert.equal(
    await edit(
      (root) =>
        root
          .querySelector('input[aria-label="aside#relatedを含める"]')
          .closest("details").open,
    ),
    true,
  );
  assert.equal(
    await edit((root) => root.querySelector(".tree").scrollTop),
    treeScroll,
  );
  assert.match(
    await edit(
      (root) => root.querySelector("[data-scope-preview]").textContent,
    ),
    /The cat sleeps/,
  );
  await edit((root) =>
    root.querySelector('input[aria-label="section#commentsを含める"]').click(),
  );
  assert.doesNotMatch(
    await edit((root) => root.querySelector("pre").textContent),
    /UNWANTED|GLOBAL|HIDDEN/,
  );
  assert.equal(
    await edit((root) => root.querySelectorAll(".excluded").length),
    2,
  );
  assert.equal(
    await edit(
      (root) => root.querySelector('input[aria-label="h2を含める"]').disabled,
    ),
    true,
  );
  await mkdir(".test-artifacts", { recursive: true });
  await source.screenshot({ path: ".test-artifacts/content-scope-editor.png" });
  ok(
    "HTML tree excludes entire child subtrees and displays their highlights, reduced counts and exact text preview",
  );
  await click("新しい条件の対象に使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel.waitForFunction(() =>
    document.querySelector("#scope-summary").textContent.includes("除外 2件"),
  );
  assert.doesNotMatch(
    await panel.locator("#source-preview").textContent(),
    /UNWANTED|GLOBAL/,
  );
  await source.reload();
  await panel.waitForFunction(() =>
    document.querySelector("#scope-summary").textContent.includes("除外 2件"),
  );
  assert.doesNotMatch(
    await panel.locator("#source-preview").textContent(),
    /UNWANTED/,
  );
  ok(
    "saved exclusions persist by URL and are applied on recapture after navigation",
  );

  await open();
  await click("ページ上で対象を選ぶ");
  await source.locator("#story p").first().click();
  assert.match(
    await edit(
      (root) => root.querySelector("[data-scope-summary]").textContent,
    ),
    /^p ·/,
  );
  await click("親要素へ");
  assert.match(
    await edit(
      (root) => root.querySelector("[data-scope-summary]").textContent,
    ),
    /^section#story/,
  );
  await click("新しい条件の対象に使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel.waitForFunction(() =>
    document
      .querySelector("#scope-summary")
      .textContent.includes("保存済み：section#story"),
  );
  ok(
    "page picking narrows the root and parent navigation adjusts the structural boundary",
  );

  // Observe the inference request from the same service-worker path used by the
  // shortcut. This test measures the exact model input, not model accuracy.
  await panel.evaluate(async (url) => {
    await chrome.storage.local.set({
      "jev-site-rule:scope-test": {
        id: "scope-test",
        name: "Scope",
        url,
        scope: "exact",
        enabled: true,
        criteria: [
          {
            id: "one",
            alias: "cat",
            type: "noul",
            instructions: "A cat is mentioned.",
            labels: [],
          },
        ],
      },
    });
    globalThis.scopeInput = undefined;
    const channel = (globalThis.scopeChannel = new BroadcastChannel(
      "jev-web-page-judge-v1",
    ));
    channel.onmessage = ({ data }) => {
      if (data.type === "hello")
        channel.postMessage({
          type: "status",
          status: {
            id: "scope-test-manager",
            ready: true,
            model: "input observer",
            phase: "ready",
          },
        });
      if (data.type === "evaluate") {
        globalThis.scopeInput = data.request.text;
        channel.postMessage({
          type: "result",
          ...data.request,
          error: "Input observed; no inference in this test.",
        });
      }
    };
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    await chrome.runtime.sendMessage({
      type: "jev-run-page",
      tabId: tab.id,
      mode: "auto",
    });
  }, url);
  await panel.waitForFunction(() => typeof globalThis.scopeInput === "string");
  const input = await panel.evaluate(() => globalThis.scopeInput);
  assert.match(input, /The cat sleeps/);
  assert.doesNotMatch(input, /街の動物|UNWANTED|GLOBAL|判定する本文/);
  ok(
    "shortcut execution path sends only the saved content range to the inference manager",
  );

  await source.evaluate(() => document.querySelector("#story").remove());
  await panel.evaluate(() => document.querySelector("#source-refresh").click());
  await panel.waitForFunction(() =>
    document
      .querySelector("#error")
      .textContent.includes("保存した本文範囲が見つかりません"),
  );
  assert.equal(await panel.locator("#source-preview").textContent(), "");
  assert.equal(await panel.getByRole("switch").count(), 1);
  await open();
  await click("自動選択に戻す");
  await click("新しい条件の対象に使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel.waitForFunction(() =>
    document.querySelector("#source-preview").textContent.includes("UNWANTED"),
  );
  ok(
    "missing saved selectors stop capture instead of expanding silently; reset restores automatic selection",
  );
  await open();
  await source.locator("#related a").click({ modifiers: ["Alt"] });
  assert.equal(source.url(), url);
  assert.doesNotMatch(
    await edit((root) => root.querySelector("pre").textContent),
    /広告を開く/,
  );
  assert.equal(
    await edit((root) => root.querySelectorAll(".excluded").length),
    1,
  );
  await source.locator("#related a").click({ modifiers: ["Alt"] });
  assert.equal(source.url(), url);
  assert.match(
    await edit(
      (root) => root.querySelector("[data-scope-preview]").textContent,
    ),
    /広告を開く/,
  );
  assert.equal(
    await edit((root) => root.querySelectorAll(".excluded").length),
    0,
  );
  // Clicking a descendant restores its excluded ancestor without changing mode.
  await edit((root) =>
    root.querySelector('input[aria-label="aside#relatedを含める"]').click(),
  );
  await source.locator("#related a").click({ modifiers: ["Alt"] });
  assert.equal(
    await edit((root) => root.querySelectorAll(".excluded").length),
    0,
  );
  await source.evaluate(() => history.pushState(null, "", "/scope-test/other"));
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  ok(
    "Alt-click excludes and restores page elements without a mode button or link navigation; navigation removes editor and listeners",
  );
  assert.deepEqual(report.errors, []);
} catch (e) {
  report.errors.push(String(e));
  throw e;
} finally {
  await writeFile(
    "docs/content-scope-test-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await context.close();
}
