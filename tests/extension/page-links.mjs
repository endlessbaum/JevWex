import assert from "node:assert/strict";
import { chromium } from "playwright";
import { build } from "esbuild";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

await build({
  stdin: {
    contents: `export { pageContent } from "./src/extension/content-scope"; export { extractLinkExcerpt } from "./src/extension/page-links"; export { readRules, saveRule } from "./src/extension/site-rules"; export { ManagerBridge } from "./src/extension/judge-channel";`,
    resolveDir: process.cwd(),
  },
  outfile: "dist/link-test.js",
  bundle: true,
  format: "esm",
  platform: "browser",
});
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
  requests: [],
  note: "リンク取得と判定入力・結果対応をテスト用応答で確認。モデル精度は対象外。",
};
const ok = (text) => {
  report.passed.push(text);
  console.log("PASS", text);
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const url = "https://huggingface.co/link-target-test/source";
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><head><meta charset="utf-8"><title>リンクの一覧</title><style>main{width:55%;font:18px/1.7 system-ui}li{padding:16px}a{display:inline-block}aside{padding:12px}</style></head><body><main><ul id="list"><li id="one"><a id="first" href="https://linked.example/space#section">料理のおすすめ</a><small><a href="https://other.example/ad">広告</a></small></li><li id="two"><a id="second" href="https://linked.example/recipe">宇宙のニュース</a><small><a href="https://other.example/ad">広告</a></small></li></ul><aside><a href="#local">ページ内</a><a download href="https://linked.example/file">ダウンロード</a><a href="javascript:void(0)">実行</a><a hidden href="https://linked.example/hidden">非表示</a></aside></main></body></html>`,
    }),
  );
  await context.route("https://linked.example/**", (route) => {
    report.requests.push(route.request().url());
    const path = new URL(route.request().url()).pathname;
    if (path === "/pdf")
      return route.fulfill({ contentType: "application/pdf", body: "PDF" });
    if (path === "/failure")
      return route.fulfill({
        status: 503,
        contentType: "text/html",
        body: "Unavailable",
      });
    if (path === "/redirect")
      return route.fulfill({
        status: 302,
        headers: { location: "https://unapproved.example/target" },
      });
    if (path === "/long")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<body>OUTSIDE<div id="contents">Astronomy ${"x".repeat(9000)}</div></body>`,
      });
    const space = path === "/space";
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><head><title>${space ? "天文の記事" : "料理の記事"}</title><script src="https://assets.example/active.js"></script></head><body><header>UNWANTED NAVIGATION</header><nav>UNWANTED MENU</nav><main><p>OUTSIDE CONTENTS</p><section ${space ? 'id="contents"' : ""}><h1>${space ? "Astronomy" : "Cooking"}</h1><p>${space ? "Astronomy stars and galaxies." : "Cooking soup and vegetables."}</p><p hidden>HIDDEN SECRET</p><p style="display:none">STYLE HIDDEN SECRET</p><img src="https://assets.example/tracker.png"><iframe src="https://assets.example/frame"></iframe><script>fetch('https://assets.example/run')</script><a href="https://assets.example/deeper">Further reading</a></section><p>BODY AFTER</p></main><footer>UNWANTED FOOTER</footer></body></html>`,
    });
  });
  await context.route("https://assets.example/**", (route) => {
    report.requests.push(route.request().url());
    return route.fulfill({ body: "unexpected" });
  });
  await context.route("https://unapproved.example/**", (route) => {
    report.requests.push(route.request().url());
    return route.fulfill({ body: "unexpected" });
  });
  const manager = await context.newPage();
  manager.on("pageerror", (error) => report.errors.push(error.message));
  await manager.goto(`chrome-extension://${id}/index.html#sites`);
  await manager.evaluate(async () => {
    globalThis.linkTest = await import("./link-test.js");
    globalThis.linkRequests = [];
    globalThis.linkContext = 2048;
    globalThis.linkBridge = new linkTest.ManagerBridge({
      status: () => ({
        ready: true,
        model: "test fixture",
        phase: "ready",
        supportsImages: false,
        inputContext: globalThis.linkContext,
      }),
      evaluate: async (request) => {
        linkRequests.push(request);
        return {
          evaluation: {
            response: {
              model: "fixture",
              answers: {
                q: {
                  type: "noul",
                  noul: request.text.includes("Astronomy") ? 0.9 : 0.1,
                },
              },
            },
            diagnostics: { warnings: [], evaluation_ms: 1 },
          },
          input: { state: request.text, questions: {} },
          presentation: { q: { alias: "天文学", labels: [], type: "noul" } },
        };
      },
      cancel: async () => {},
      manage: () => {},
    });
  });
  const panel = await context.newPage();
  panel.on("pageerror", (error) => report.errors.push(error.message));
  await panel.setViewportSize({ width: 420, height: 1000 });
  await panel.goto(`chrome-extension://${id}/panel.html`);
  const source = await context.newPage();
  source.on("pageerror", (error) => report.errors.push(error.message));
  await source.goto(url);
  await source.bringToFront();
  await panel.waitForFunction(() =>
    document
      .querySelector("#source-url")
      .textContent.includes("link-target-test"),
  );
  const tabId = await manager.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
    url,
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
  const click = (label) =>
    edit(
      (root, label) =>
        [...root.querySelectorAll("button")]
          .find((button) => button.textContent === label)
          .click(),
      label,
    );
  const scopeCapture = (scope) =>
    manager.evaluate(
      async ({ tabId, scope }) => {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func: linkTest.pageContent,
          args: [scope, false],
        });
        return injection.result;
      },
      { tabId, scope },
    );

  // Start from the existing new-rule flow, select an anchor in the real editor.
  await panel.locator("#new-rule").click();
  await panel.locator("#create-name").fill("リンク先の天文学");
  await panel
    .locator('#create-criteria [data-field="instructions"]')
    .fill("The destination article is about astronomy.");
  await panel.evaluate(() =>
    document.querySelector("#create-target-edit").click(),
  );
  await source.locator("[data-jev-scope-editor]").waitFor();
  await edit((root) =>
    root
      .querySelector('input[aria-label="a#firstを含める"]')
      .closest("summary")
      .querySelector("button")
      .click(),
  );
  assert.equal(
    await edit((root) => root.querySelector("[data-scope-links]").checked),
    true,
  );
  for (let n = 0; n < 30; n++) {
    if (
      (
        await edit(
          (root) => root.querySelector("[data-scope-link-preview]").textContent,
        )
      ).includes("未許可")
    )
      break;
    await source.waitForTimeout(100);
  }
  assert.equal(report.requests.length, 0);
  assert.match(
    await edit(
      (root) => root.querySelector("[data-scope-link-preview]").textContent,
    ),
    /未許可/,
  );
  assert.equal(source.url(), url);
  await click("この対象を使う");
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  const allow = panel.getByRole("button", {
    name: "リンク先の取得を許可",
    exact: true,
  });
  await allow.waitFor();
  // Exercise the real optional-host permission request in a disposable profile.
  const settings = await context.newPage();
  await settings.goto("chrome://extensions/");
  await settings.evaluate(
    (id) =>
      chrome.developerPrivate.addHostPermission(id, "https://linked.example/*"),
    id,
  );
  await settings.close();
  await source.bringToFront();
  await allow.click();
  await panel.waitForFunction(() =>
    document
      .querySelector("[data-link-permissions] pre")
      .textContent.includes("Astronomy"),
  );
  const preview = await panel
    .locator("[data-link-permissions] pre")
    .innerText();
  assert.match(preview, /天文の記事/);
  assert.doesNotMatch(preview, /UNWANTED|HIDDEN|fetch\(/);
  assert.deepEqual(report.requests, ["https://linked.example/space"]);
  await mkdir(".test-artifacts", { recursive: true });
  await panel.screenshot({
    path: ".test-artifacts/link-destination-preview.png",
    fullPage: true,
  });
  ok(
    "selecting an anchor enables destination mode; denied origins do not fetch; real permission and inert HTML preview work",
  );
  await panel.locator("#create-save").click();
  await panel.locator("#create-condition").waitFor({ state: "hidden" });
  const stored = await manager.evaluate(() => linkTest.readRules());
  assert.doesNotMatch(JSON.stringify(stored), /Astronomy stars|天文の記事/);

  const initial = await scopeCapture({
    root: "#first",
    exclude: [],
    linkedPages: true,
  });
  assert.equal(initial.links[0].url, "https://linked.example/space");
  assert.equal(initial.links[0].label, "料理のおすすめ");
  const aside = await scopeCapture({
    root: "aside",
    exclude: [],
    linkedPages: true,
  });
  assert.equal(aside.links.length, 0);
  const plain = await scopeCapture({ root: "#first", exclude: [] });
  assert.equal(plain.links, undefined);
  ok(
    "destination URLs resolve without fragments; downloads, page anchors, hidden links and non-HTTP links are excluded; ordinary targets stay local",
  );

  await panel.locator("#run").click();
  const job = () =>
    manager.evaluate(
      async (tabId) =>
        (await chrome.storage.session.get(`jev-page-job:${tabId}`))[
          `jev-page-job:${tabId}`
        ],
      tabId,
    );
  async function completed(expectedId) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const state = await job();
      if (
        (!expectedId || state?.jobId === expectedId) &&
        (state?.phase === "complete" || state?.phase === "error")
      )
        return state;
      await source.waitForTimeout(100);
    }
    throw new Error("Page judgement timed out");
  }
  assert.equal((await completed()).phase, "complete");
  let inputs = await manager.evaluate(() => linkRequests);
  assert.equal(inputs.length, 1);
  assert.match(inputs[0].text, /Astronomy stars/);
  assert.ok(inputs[0].text.length <= Math.floor(2048 * 0.8));
  assert.doesNotMatch(inputs[0].text, /天文の記事|料理のおすすめ/);
  assert.doesNotMatch(inputs[0].text, /OUTSIDE CONTENTS|BODY AFTER/);
  const overlay = await shadow("data-jev-overlay", (root) => root.textContent);
  assert.match(overlay, /リンク先[\s\S]*90\.0%/);
  ok(
    "saved condition evaluates fetched destination content and reports the result on the original anchor",
  );

  // Apply destination mode to a list and exclude each item's advertising link.
  await manager.evaluate(async () => {
    const rules = await linkTest.readRules();
    rules[0].contentScope = {
      root: "#list",
      exclude: [],
      items: ":scope > li",
      linkedPages: true,
      sharedExclude: [
        {
          container: "#list",
          items: ":scope > li",
          path: ":scope > small:nth-of-type(1)",
        },
      ],
    };
    await linkTest.saveRule(rules[0]);
    globalThis.linkRequests = [];
  });
  const list = await scopeCapture({
    root: "#list",
    exclude: [],
    items: ":scope > li",
    linkedPages: true,
    sharedExclude: [
      {
        container: "#list",
        items: ":scope > li",
        path: ":scope > small:nth-of-type(1)",
      },
    ],
  });
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].links.length, 1);
  assert.equal(list.items[1].links.length, 1);
  const started = await manager.evaluate(
    async (tabId) =>
      chrome.runtime.sendMessage({ type: "jev-run-page", tabId, mode: "text" }),
    tabId,
  );
  assert.equal((await completed(started.jobId)).phase, "complete");
  inputs = await manager.evaluate(() => linkRequests);
  assert.equal(inputs.length, 2);
  assert.match(inputs[0].text, /Astronomy/);
  assert.doesNotMatch(inputs[0].text, /Cooking soup/);
  assert.match(inputs[1].text, /Cooking soup/);
  assert.match(inputs[1].text, /OUTSIDE CONTENTS[\s\S]*BODY AFTER/);
  assert.doesNotMatch(inputs[1].text, /Astronomy stars/);
  ok(
    "per-item list judgements preserve link-to-result identity and shared exclusions without mixing destination articles",
  );
  await source.locator("#first").evaluate((a) => {
    a.href = "https://linked.example/long";
  });
  let previousLength = 0;
  for (const inputContext of [2048, 4096]) {
    await manager.evaluate((inputContext) => {
      globalThis.linkContext = inputContext;
      globalThis.linkRequests = [];
    }, inputContext);
    const resized = await manager.evaluate(
      (tabId) =>
        chrome.runtime.sendMessage({
          type: "jev-run-page",
          tabId,
          mode: "text",
        }),
      tabId,
    );
    assert.equal((await completed(resized.jobId)).phase, "complete");
    const text = await manager.evaluate(() => linkRequests[0].text);
    assert.ok(text.length <= Math.floor(inputContext * 0.8));
    assert.ok(text.length > previousLength);
    assert.match(text, /一部を省略/);
    assert.doesNotMatch(text, /OUTSIDE/);
    previousLength = text.length;
  }
  ok(
    "changing the loaded model context changes the actual inference input budget to at most 80%, with explicit truncation",
  );

  // An unavailable destination must not become an evaluation of its link label.
  for (const [path, expected] of [
    ["pdf", /HTMLページではありません/],
    ["failure", /HTTP 503/],
    ["redirect", /リダイレクト/],
  ]) {
    await source.locator("#first").evaluate((a, path) => {
      a.href = `https://linked.example/${path}`;
    }, path);
    await manager.evaluate(() => {
      globalThis.linkRequests = [];
    });
    const retry = await manager.evaluate(
      (tabId) =>
        chrome.runtime.sendMessage({
          type: "jev-run-page",
          tabId,
          mode: "text",
        }),
      tabId,
    );
    assert.equal((await completed(retry.jobId)).phase, "complete");
    assert.match(
      await shadow("data-jev-overlay", (root) => root.textContent),
      expected,
    );
    const remaining = await manager.evaluate(() => linkRequests);
    assert.equal(remaining.length, 1);
    assert.match(remaining[0].text, /Cooking soup/);
  }
  assert.ok(
    !report.requests.some((url) =>
      url.startsWith("https://unapproved.example/"),
    ),
  );
  ok(
    "PDFs, HTTP failures and redirects show per-item errors, never infer from source text, and continue with the next item",
  );
  await source.locator("#first").evaluate((a) => {
    a.href = "https://linked.example/space";
  });
  const finalRun = await manager.evaluate(
    (tabId) =>
      chrome.runtime.sendMessage({ type: "jev-run-page", tabId, mode: "text" }),
    tabId,
  );
  assert.equal((await completed(finalRun.jobId)).phase, "complete");

  // Remote markup must not execute or cause nested resource loads, and excerpts truncate.
  const extracted = await manager.evaluate(() =>
    linkTest.extractLinkExcerpt(
      `<title>Title &amp; detail</title><main><p>${"x".repeat(9000)}</p></main><script>window.bad=true</script><img src="https://assets.example/again">`,
      1638,
    ),
  );
  assert.equal(extracted.text.length, 1638);
  assert.equal(extracted.truncated, true);
  assert.equal(extracted.title, "Title & detail");
  const scopes = await manager.evaluate(() => [
    linkTest.extractLinkExcerpt(
      '<html><head><title>HEAD SECRET</title></head><body>BODY BEFORE<div id="contents">ID BODY</div>BODY AFTER</body></html>',
      1000,
    ),
    linkTest.extractLinkExcerpt(
      '<body>BODY BEFORE<div class="contents">CLASS BODY</div>BODY AFTER</body>',
      1000,
    ),
    linkTest.extractLinkExcerpt(
      "<body>BODY BEFORE<contents>TAG BODY</contents>BODY AFTER</body>",
      1000,
    ),
    linkTest.extractLinkExcerpt(
      "<head><title>HEAD SECRET</title></head><body>BODY BEFORE<main>MAIN BODY</main><article>ARTICLE BODY</article>BODY AFTER</body>",
      1000,
    ),
  ]);
  assert.equal(scopes[0].text, "ID BODY");
  assert.equal(scopes[1].text, "CLASS BODY");
  assert.equal(scopes[2].text, "TAG BODY");
  assert.match(
    scopes[3].text,
    /BODY BEFORE[\s\S]*MAIN BODY[\s\S]*ARTICLE BODY[\s\S]*BODY AFTER/,
  );
  assert.doesNotMatch(scopes[3].text, /HEAD SECRET/);
  ok(
    "contents ID, class and tag are preferred; missing contents falls back strictly to body and excludes head text",
  );
  assert.ok(
    report.requests.every((url) => url.startsWith("https://linked.example/")),
  );
  ok(
    "HTML parsing does not load scripts, images, frames or further links; entity decoding and model-dependent character limits work",
  );
  assert.deepEqual(report.errors, []);
  await mkdir(".test-artifacts", { recursive: true });
  await source.screenshot({
    path: ".test-artifacts/link-destination-results.png",
  });
} finally {
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/page-links-report.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
