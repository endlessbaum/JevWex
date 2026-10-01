import assert from "node:assert/strict";
import { chromium } from "playwright";
import { build } from "esbuild";
import { resolve } from "node:path";

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"],
});
context.setDefaultTimeout(10000);
const url = "https://huggingface.co/input-monitor-test";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<main><h1>Input monitor</h1><form><input id="message"><textarea id="notes"></textarea><input id="other"><input id="secret" type="password" value="SECRET"><div id="editable" contenteditable="true"><p>Editable</p></div></form></main>',
    }),
  );
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/index.html#sites`);
  const bundle = await build({
    stdin: {
      contents:
        'export {pageContent} from "./src/extension/content-scope"; export {readInputMonitor} from "./src/extension/input-monitor";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "inputTest",
  });
  await manager.evaluate(
    bundle.outputFiles[0].text + ";globalThis.inputTest=inputTest;",
  );
  await manager.evaluate(() => {
    globalThis.requests = [];
    globalThis.events = [];
    globalThis.hold = false;
    globalThis.replies = [];
    chrome.runtime.onMessage.addListener((data) => {
      if (data.type === "jev-input-ready")
        globalThis.events.push({ ...data, time: Date.now() });
    });
    const channel = (globalThis.observer = new BroadcastChannel(
      "jev-web-page-judge-v1",
    ));
    globalThis.respond = (request) =>
      channel.postMessage({
        type: "result",
        ...request,
        result: {
          evaluation: {
            response: { answers: { result: { type: "noul", noul: 0.5 } } },
          },
          presentation: { result: { alias: request.text, labels: [] } },
        },
      });
    channel.onmessage = ({ data }) => {
      if (data.type === "hello")
        channel.postMessage({
          type: "status",
          status: {
            id: "input-observer",
            ready: true,
            model: "observer",
            phase: "ready",
          },
        });
      if (data.type === "evaluate") {
        globalThis.requests.push(data.request);
        if (globalThis.hold) globalThis.replies.push(data.request);
        else globalThis.respond(data.request);
      }
    };
  });
  const source = await context.newPage();
  await source.goto(url);
  const tabId = await manager.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
    url,
  );
  const rule = {
    id: "input",
    name: "入力欄",
    url,
    scope: "exact",
    enabled: true,
    criteria: [
      {
        id: "result",
        alias: "判定",
        type: "noul",
        instructions: "文章を確認",
        labels: [],
      },
    ],
    contentScope: { root: "#message", exclude: [], inputValue: true },
  };
  const save = (rule) =>
    manager.evaluate(
      (rule) =>
        chrome.storage.local.set({ ["jev-site-rule:" + rule.id]: rule }),
      rule,
    );
  const probe = () =>
    manager.evaluate(async (tabId) => {
      const [entry] = await chrome.scripting.executeScript({
        target: { tabId },
        func: inputTest.readInputMonitor,
      });
      return entry.result;
    }, tabId);
  const waitMonitor = async (expected, selector) => {
    for (let n = 0; n < 100; n++) {
      const state = await probe();
      if (
        JSON.stringify(state?.rules.map((r) => r.id).sort() ?? []) ===
          JSON.stringify([...expected].sort()) &&
        (!selector || state?.rules[0]?.selector === selector)
      )
        return state;
      await delay(30);
    }
    throw new Error("monitor configuration did not update");
  };
  const requests = () =>
    manager.evaluate(() =>
      globalThis.requests.map((r) => ({ text: r.text, ruleId: r.ruleId })),
    );
  const clear = () =>
    manager.evaluate(() => {
      globalThis.requests = [];
      globalThis.events = [];
    });
  const waitText = (text) =>
    manager.waitForFunction(
      (text) => globalThis.requests.some((r) => r.text === text),
      text,
    );
  const terminal = () =>
    manager.waitForFunction(async (tabId) => {
      const state = (await chrome.storage.session.get(`jev-page-job:${tabId}`))[
        `jev-page-job:${tabId}`
      ];
      return state?.phase === "complete";
    }, tabId);
  const capture = (scope) =>
    manager.evaluate(
      async ({ scope, tabId }) => {
        const [entry] = await chrome.scripting.executeScript({
          target: { tabId },
          func: inputTest.pageContent,
          args: [scope],
        });
        return entry.result;
      },
      { scope, tabId },
    );

  await save(rule);
  await source.locator("#message").fill("OFF");
  await delay(150);
  assert.deepEqual(await requests(), []);
  assert.equal((await capture(rule.contentScope)).text, "OFF");
  assert.doesNotMatch(
    (await capture({ root: "form", exclude: [] })).text,
    /OFF|SECRET/,
  );
  assert.match(
    (await capture({ root: "#secret", exclude: [], inputValue: true })).error,
    /テキスト入力欄/,
  );
  console.log(
    "PASS specified input values are captured, ordinary page capture excludes controls, passwords are rejected, default watch is off",
  );

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/panel.html`);
  await source.bringToFront();
  await source.locator("#message").fill("");
  await panel.getByText("対象・基準を編集", { exact: true }).click();
  await panel.evaluate(() =>
    document.querySelector("#create-target-edit").click(),
  );
  await source.locator("[data-jev-scope-editor]").waitFor();
  const sourceCDP = await context.newCDPSession(source);
  const editScope = async (fn) => {
    const { root } = await sourceCDP.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (node) =>
      node.attributes?.includes("data-jev-scope-editor")
        ? node.shadowRoots?.[0]
        : (node.children ?? []).map(find).find(Boolean);
    const { object } = await sourceCDP.send("DOM.resolveNode", {
      backendNodeId: find(root).backendNodeId,
    });
    const result = await sourceCDP.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function(){return (${fn})(this)}`,
    });
    await sourceCDP.send("Runtime.releaseObject", {
      objectId: object.objectId,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  };
  await editScope((root) =>
    [...root.querySelectorAll("button")]
      .find((button) => button.textContent === "親要素へ")
      .click(),
  );
  await editScope((root) => {
    const summary = root
      .querySelector('input[aria-label="input#messageを含める"]')
      .closest("summary");
    [...summary.querySelectorAll("button")]
      .find((button) => button.textContent === "この要素以下に絞る")
      .click();
  });
  assert.equal(
    await editScope(
      (root) => root.querySelector("[data-scope-preview]").textContent,
    ),
    "",
  );
  assert.equal(
    await editScope(
      (root) =>
        [...root.querySelectorAll("button")].find(
          (button) => button.textContent === "この対象を使う",
        ).disabled,
    ),
    false,
  );
  await editScope((root) =>
    [...root.querySelectorAll("button")]
      .find((button) => button.textContent === "この対象を使う")
      .click(),
  );
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel.locator("#create-save").click();
  await panel.locator("#create-condition").waitFor({ state: "hidden" });
  assert.deepEqual(
    await manager.evaluate(
      async () =>
        (await chrome.storage.local.get("jev-site-rule:input"))[
          "jev-site-rule:input"
        ].contentScope,
    ),
    rule.contentScope,
  );
  console.log(
    "PASS visual target picker selects and saves an empty input with its value mode",
  );
  await panel
    .getByRole("switch", { name: "入力欄の入力監視", exact: true })
    .check();
  await waitMonitor(["input"]);
  await panel.close();
  await clear();
  const finalInputAt = await source.evaluate(async () => {
    const input = document.querySelector("#message");
    for (const value of ["a", "ab", "abc"]) {
      input.value = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      if (value !== "abc") await new Promise((done) => setTimeout(done, 15));
    }
    return Date.now();
  });
  await waitText("abc");
  await terminal();
  assert.deepEqual(await requests(), [{ text: "abc", ruleId: "input" }]);
  const events = await manager.evaluate(() => globalThis.events);
  assert.equal(events.length, 1);
  assert.ok(events[0].time - finalInputAt >= 45);
  console.log(
    "PASS rapid typing debounces until 50ms after the last input and works after the panel closes",
  );

  await clear();
  await source.locator("#other").fill("unrelated");
  await delay(150);
  assert.deepEqual(await requests(), []);
  await source.evaluate(() => {
    const input = document.querySelector("#message");
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    input.value = "にほん";
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );
  });
  await delay(150);
  assert.deepEqual(await requests(), []);
  await source.evaluate(() => {
    const input = document.querySelector("#message");
    input.value = "日本語";
    input.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await waitText("日本語");
  await terminal();
  assert.deepEqual(await requests(), [{ text: "日本語", ruleId: "input" }]);
  console.log(
    "PASS unrelated inputs do not trigger judgement and IME composition waits until conversion finishes",
  );

  await clear();
  await manager.evaluate(() => {
    globalThis.hold = true;
  });
  await source.locator("#message").fill("OLD");
  await waitText("OLD");
  await source.locator("#message").fill("LATEST");
  await waitText("LATEST");
  await manager.evaluate(() => {
    globalThis.hold = false;
    for (const reply of globalThis.replies.reverse()) globalThis.respond(reply);
    globalThis.replies = [];
  });
  await terminal();
  const overlayText = async () => {
    const { root } = await sourceCDP.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (node) =>
      node.attributes?.includes("data-jev-overlay")
        ? node.shadowRoots?.[0]
        : (node.children ?? []).map(find).find(Boolean);
    const shadow = find(root);
    if (!shadow) return "";
    const { object } = await sourceCDP.send("DOM.resolveNode", {
      backendNodeId: shadow.backendNodeId,
    });
    const result = await sourceCDP.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: "function(){return this.textContent}",
    });
    await sourceCDP.send("Runtime.releaseObject", {
      objectId: object.objectId,
    });
    return result.result.value;
  };
  assert.match(await overlayText(), /LATEST/);
  assert.doesNotMatch(await overlayText(), /OLD/);
  console.log(
    "PASS typing during judgement cancels the old request and late results cannot overwrite the latest result",
  );

  await clear();
  await source.locator("#message").fill("");
  await delay(300);
  assert.deepEqual(await requests(), []);
  assert.doesNotMatch(await overlayText(), /LATEST/);
  await source.locator("#message").fill("cancel debounce");
  await save({ ...rule, watchInput: false });
  await waitMonitor([]);
  await delay(200);
  assert.deepEqual(await requests(), []);
  console.log(
    "PASS empty inputs clear old results without inference and switching OFF cancels queued work",
  );

  await save({ ...rule, watchInput: true });
  await waitMonitor(["input"]);
  await source.reload();
  await waitMonitor(["input"]);
  await clear();
  await source.locator("#message").fill("AFTER RELOAD");
  await waitText("AFTER RELOAD");
  await terminal();
  assert.deepEqual(await requests(), [
    { text: "AFTER RELOAD", ruleId: "input" },
  ]);
  console.log(
    "PASS enabled monitor is restored on permitted page reload without duplicate listeners",
  );

  await save({ ...rule, enabled: false, watchInput: true });
  await waitMonitor([]);
  await clear();
  await source.locator("#message").fill("disabled condition");
  await delay(150);
  assert.deepEqual(await requests(), []);
  await save({
    ...rule,
    watchInput: true,
    contentScope: { root: "#notes", exclude: [], inputValue: true },
  });
  await waitMonitor(["input"], "#notes");
  await source.locator("#notes").fill("textarea\nvalue");
  await waitText("textarea\nvalue");
  await terminal();
  await clear();
  await save({
    ...rule,
    watchInput: true,
    contentScope: { root: "#editable", exclude: [], inputValue: true },
  });
  await manager.waitForFunction(async (tabId) => {
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId },
      func: inputTest.readInputMonitor,
    });
    return entry.result?.rules[0]?.selector === "#editable";
  }, tabId);
  await source.locator("#editable").fill("editable value");
  await waitText("editable value");
  await terminal();
  console.log(
    "PASS disabling a condition stops monitoring; textarea and contenteditable use their current values",
  );
  await clear();
  await source.evaluate(() => {
    const previous = document.querySelector("#editable");
    previous.replaceWith(previous.cloneNode(false));
  });
  await source.locator("#editable").fill("replaced element");
  await waitText("replaced element");
  await terminal();
  const notesRule = {
    ...rule,
    id: "notes",
    name: "Notes",
    watchInput: true,
    contentScope: { root: "#notes", exclude: [], inputValue: true },
  };
  await save(notesRule);
  await waitMonitor(["input", "notes"]);
  await clear();
  await source.evaluate(() => {
    const notes = document.querySelector("#notes");
    notes.value = "changed textarea";
    notes.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const editable = document.querySelector("#editable");
    editable.textContent = "changed editable";
    editable.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await waitText("changed editable");
  await waitText("changed textarea");
  await terminal();
  assert.deepEqual(
    (await requests()).sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    [
      { text: "changed editable", ruleId: "input" },
      { text: "changed textarea", ruleId: "notes" },
    ],
  );
  console.log(
    "PASS replacement DOM elements stay monitored and changes to multiple specified fields are judged together",
  );

  await clear();
  await manager.evaluate(() => {
    globalThis.hold = true;
  });
  await source.locator("#editable").fill("OFF WHILE RUNNING");
  await waitText("OFF WHILE RUNNING");
  await save({
    ...rule,
    contentScope: { root: "#editable", exclude: [], inputValue: true },
    watchInput: false,
  });
  await waitMonitor(["notes"]);
  await manager.waitForFunction(
    async (tabId) =>
      (await chrome.storage.session.get(`jev-page-job:${tabId}`))[
        `jev-page-job:${tabId}`
      ]?.phase === "cancelled",
    tabId,
  );
  await manager.evaluate(() => {
    globalThis.hold = false;
    for (const reply of globalThis.replies) globalThis.respond(reply);
    globalThis.replies = [];
  });
  assert.equal(await source.locator("[data-jev-overlay]").isVisible(), false);
  console.log(
    "PASS switching OFF cancels running inference and suppresses a late response",
  );

  await manager.evaluate(() =>
    chrome.storage.local.remove("jev-site-rule:notes"),
  );
  await save({ ...rule, watchInput: false });
  await waitMonitor([]);
  await clear();
  await source.locator("#message").fill("MANUAL");
  await manager.evaluate(() => {
    globalThis.hold = true;
  });
  const manual = await manager.evaluate(
    (tabId) =>
      chrome.runtime.sendMessage({
        type: "jev-run-page",
        tabId,
        mode: "text",
      }),
    tabId,
  );
  assert.ok(manual.jobId);
  await waitText("MANUAL");
  await save({ ...rule, watchInput: true });
  await waitMonitor(["input"]);
  await source.locator("#message").fill("QUEUED LATEST");
  await delay(150);
  assert.deepEqual(await requests(), [{ text: "MANUAL", ruleId: "input" }]);
  await manager.evaluate(() => {
    globalThis.hold = false;
    for (const reply of globalThis.replies) globalThis.respond(reply);
    globalThis.replies = [];
  });
  await waitText("QUEUED LATEST");
  await terminal();
  assert.match(await overlayText(), /QUEUED LATEST/);
  console.log(
    "PASS an input change during manual judgement waits and then judges the latest value",
  );
} finally {
  await context.close();
}
