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
const report = { passed: [], errors: [] };
const ok = (name) => {
  report.passed.push(name);
  console.log("PASS", name);
};
const item = (id) =>
  `<li id="${id}"><article><a id="${id}-image" href="/unwanted">IMAGE ${id}</a><div><h3><a id="${id}-title">TITLE ${id}</a></h3><p>BODY ${id}</p></div><div id="${id}-meta">META ${id}<span>DETAIL ${id}</span></div></article></li>`;
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const url = "https://huggingface.co/shared-exclusions-test";
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><head><title>共通除外</title><style>body{font:16px/1.5 system-ui;margin:24px;background:#f2f6f3}main{width:58%}li{background:white;margin:12px 0;padding:10px}h3{margin:5px 0}p{margin:5px 0}</style></head><body><main id="main"><ul id="list">${["alpha", "beta", "gamma"].map(item).join("")}</ul><ul id="other">${["other1", "other2"].map(item).join("")}</ul></main></body></html>`,
    }),
  );
  const panel = await context.newPage();
  panel.on("pageerror", (e) => report.errors.push(String(e)));
  await panel.goto(`chrome-extension://${id}/panel.html`);
  const source = await context.newPage();
  await source.goto(url);
  await source.bringToFront();
  await panel.waitForFunction(() =>
    document
      .querySelector("#source-preview")
      .textContent.includes("BODY alpha"),
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
    const target = find(root);
    assert.ok(target, "scope editor exists");
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
  const click = (text) =>
    edit(
      (root, text) =>
        [...root.querySelectorAll("button")]
          .find((b) => b.textContent === text)
          .click(),
      text,
    );
  const toggle = (label) =>
    edit(
      (root, label) =>
        root.querySelector(`input[aria-label="${label}を含める"]`).click(),
      label,
    );
  const checked = (label) =>
    edit(
      (root, label) =>
        root.querySelector(`input[aria-label="${label}を含める"]`).checked,
      label,
    );
  const preview = () => edit((root) => root.querySelector("pre").textContent);
  const open = async () => {
    await openStandaloneScopeEditor(panel);
    await source.locator("[data-jev-scope-editor]").waitFor();
  };
  const save = async () => {
    await click("新しい条件の対象に使う");
    await source
      .locator("[data-jev-scope-editor]")
      .waitFor({ state: "detached" });
  };
  const refresh = async (needle) => {
    await panel.evaluate(() =>
      document.querySelector("#source-refresh").click(),
    );
    await panel.waitForFunction(
      (needle) =>
        document.querySelector("#source-preview").textContent.includes(needle),
      needle,
    );
  };
  const key = `jev-content-scope:${url}`;
  const stored = () =>
    panel.evaluate(
      async (key) => (await chrome.storage.local.get(key))[key],
      key,
    );

  await open();
  assert.equal(
    await edit((root) =>
      [...root.querySelectorAll(".tree button")].some(
        (b) => b.textContent === "ここを対象",
      ),
    ),
    false,
  );
  await toggle("a#alpha-image");
  for (const name of ["alpha", "beta", "gamma"]) {
    assert.equal(await checked(`a#${name}-image`), false);
    assert.equal(await checked(`a#${name}-title`), true);
  }
  assert.equal(await checked("a#other1-image"), true);
  assert.equal(
    await edit((root) => root.querySelectorAll(".excluded").length),
    3,
  );
  assert.doesNotMatch(await preview(), /IMAGE (alpha|beta|gamma)/);
  assert.match(await preview(), /IMAGE other1/);
  ok(
    "child exclusions update all same-list checkboxes, highlights and preview before batch selection; other lists and other paths remain included; ambiguous root labels are removed",
  );

  await toggle("div#beta-meta");
  assert.equal(
    await edit((root) => root.querySelectorAll(".excluded").length),
    6,
  );
  assert.doesNotMatch(await preview(), /(META|DETAIL) (alpha|beta|gamma)/);
  await toggle("a#gamma-image");
  for (const name of ["alpha", "beta", "gamma"])
    assert.equal(await checked(`a#${name}-image`), true);
  await toggle("a#beta-image");
  await save();
  const scope = await stored();
  assert.equal(scope.root, null);
  assert.deepEqual(scope.exclude, []);
  assert.equal(scope.sharedExclude.length, 2);
  assert.ok(
    scope.sharedExclude.every(
      (rule) =>
        rule.container === "#list" && !/alpha|beta|gamma/.test(rule.path),
    ),
  );
  await source.reload();
  await refresh("BODY gamma");
  assert.doesNotMatch(
    await panel.locator("#source-preview").textContent(),
    /(IMAGE|META|DETAIL) (alpha|beta|gamma)/,
  );
  ok(
    "restoring any peer restores all peers; multiple relative paths persist with automatic main selection and survive reload",
  );

  await source.evaluate(
    (html) =>
      document.querySelector("#list").insertAdjacentHTML("beforeend", html),
    item("delta"),
  );
  await source.evaluate(() => document.querySelector("#beta-image").remove());
  await refresh("BODY delta");
  assert.doesNotMatch(
    await panel.locator("#source-preview").textContent(),
    /(IMAGE|META|DETAIL) (alpha|beta|gamma|delta)/,
  );
  assert.match(
    await panel.locator("#source-preview").textContent(),
    /TITLE beta/,
  );
  ok(
    "newly loaded items inherit exclusions on refresh; missing optional children do not remove item content or exclude a different nested link",
  );

  await open();
  await edit((root) => {
    const select = root.querySelector('[aria-label="ul#listの判定方法"]');
    select.value = "individual";
    select.dispatchEvent(new Event("change"));
  });
  assert.equal(
    await edit((root) => root.querySelectorAll(".outline.item").length),
    4,
  );
  await toggle("li#gamma");
  assert.equal(await checked("li#alpha"), true);
  assert.equal(await checked("li#gamma"), false);
  assert.equal(
    await edit((root) => root.querySelectorAll(".outline.item").length),
    3,
  );
  assert.doesNotMatch(await preview(), /BODY gamma/);
  await toggle("li#gamma");
  await source.locator("#alpha-title").click({ modifiers: ["Alt"] });
  assert.equal(source.url(), url);
  assert.doesNotMatch(await preview(), /TITLE (alpha|beta|gamma|delta)/);
  await edit((root) =>
    root.querySelectorAll(".tree details").forEach((el) => {
      el.open = true;
    }),
  );
  await mkdir(".test-artifacts", { recursive: true });
  await source.screenshot({
    path: ".test-artifacts/shared-exclusions-editor.png",
  });
  await save();
  await refresh("【4件目");
  assert.doesNotMatch(
    await panel.locator("#source-preview").textContent(),
    /IMAGE|TITLE|META|DETAIL/,
  );
  assert.equal((await stored()).sharedExclude.length, 3);
  ok(
    "batch selection preserves shared exclusions, whole-item exclusion affects only one item, and page picking propagates descendants to every item",
  );

  // Older saved absolute exclusions should acquire the same shared behavior.
  await panel.evaluate(
    async ({ key }) =>
      chrome.storage.local.set({
        [key]: {
          root: "#list",
          items: ":scope > li",
          exclude: ["#alpha-meta"],
        },
      }),
    { key },
  );
  await refresh("BODY delta");
  await panel.waitForFunction(
    () =>
      !document
        .querySelector("#source-preview")
        .textContent.includes("META delta"),
  );
  assert.doesNotMatch(
    await panel.locator("#source-preview").textContent(),
    /META|DETAIL/,
  );
  await open();
  await toggle("div#delta-meta");
  for (const name of ["alpha", "beta", "gamma", "delta"])
    assert.equal(await checked(`div#${name}-meta`), true);
  await save();
  assert.equal((await stored()).sharedExclude, undefined);
  assert.deepEqual((await stored()).exclude, []);
  ok(
    "previously saved individual child exclusions are shared and can be restored from any item",
  );
  await open();
  await edit((root) => {
    const row = root
      .querySelector('input[aria-label="li#alphaを含める"]')
      .closest("summary");
    [...row.querySelectorAll("button")]
      .find((button) => button.textContent === "この要素以下に絞る")
      .click();
  });
  assert.match(await preview(), /BODY alpha/);
  assert.doesNotMatch(await preview(), /BODY (beta|gamma|delta)/);
  await save();
  assert.equal((await stored()).root, "#alpha");
  ok(
    "renamed narrow-to-subtree button retains its distinct root-selection behavior",
  );
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.errors.push(String(error));
  throw error;
} finally {
  await writeFile(
    "docs/shared-exclusion-test-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await context.close();
}
