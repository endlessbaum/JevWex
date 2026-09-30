import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { navigate, fillSingleCriterion, runEvaluation } from "./ui-helpers.mjs";

await mkdir(".test-artifacts", { recursive: true });
const profile = await mkdtemp(resolve(".test-artifacts/byok-profile-"));
const keyName = "jev-cloud-credentials:v1";
const initialKey = "persist-only-test-key",
  replacementKey = "replacement-test-key";
const secondKey = "second-profile-test-key";
let secondModel = "jev-two";
const report = { passed: [], errors: [], requests: 0, browserRestarts: 0 };
let mode = "success",
  expectedKey = initialKey;
const logs = [];
const ok = (name) => {
  report.passed.push(name);
  console.log("PASS", name);
};
const server = createServer(async (req, res) => {
  report.requests++;
  try {
    assert.ok(["/cloud", "/cloud-two"].includes(req.url));
    assert.equal(req.method, "POST");
    assert.equal(
      req.headers.authorization,
      `Bearer ${req.url === "/cloud-two" ? secondKey : expectedKey}`,
    );
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    assert.equal(
      input.model,
      req.url === "/cloud-two" ? secondModel : "jev-latest",
    );
    if (mode === "wait") return;
    const status =
      { authentication: 401, limited: 429, server: 503 }[mode] ?? 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      status !== 200
        ? `Authorization: Bearer ${expectedKey}`
        : JSON.stringify({
            model:
              mode === "echo"
                ? expectedKey
                : req.url === "/cloud-two"
                  ? "byok-second-fixture"
                  : "byok-fixture",
            answers: Object.fromEntries(
              Object.keys(input.questions).map((id) => [
                id,
                { type: "noul", noul: 0.9 },
              ]),
            ),
          }),
    );
  } catch (error) {
    report.errors.push(String(error));
    res.writeHead(500);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/cloud`;
let context, manager, source, extensionId;
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
  context.setDefaultTimeout(15000);
  context.on("console", (message) => logs.push(message.text()));
  context.on("page", (page) =>
    page.on("pageerror", (error) => report.errors.push(error.message)),
  );
  const cdp = await context.browser().newBrowserCDPSession();
  const loaded = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  if (extensionId) assert.equal(loaded.id, extensionId);
  extensionId = loaded.id;
  await context.route("https://huggingface.co/byok-test", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: "<main>BYOK source fixture</main>",
    }),
  );
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html#models`);
  await manager.waitForFunction(
    () => !document.querySelector("#cloud-key-save").disabled,
  );
  // Any page-side cloud fetch is a failure; inference must use the worker.
  await manager.evaluate((endpoint) => {
    const original = window.fetch;
    window.fetch = (...args) => {
      if ([endpoint, endpoint + "-two"].includes(String(args[0])))
        throw new Error("Page-side API fetch is forbidden");
      return original(...args);
    };
  }, endpoint);
  source = await context.newPage();
  await source.goto("https://huggingface.co/byok-test");
}
async function inContent(fn, arg) {
  return manager.evaluate(`(async () => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === ${JSON.stringify(source.url())});
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (${fn}), args: [${JSON.stringify(arg ?? null)}] });
    return result.result === undefined ? { injection: result } : result.result;
  })()`);
}
async function status() {
  return manager.evaluate(() =>
    chrome.runtime.sendMessage({ type: "jev-cloud-status" }),
  );
}
try {
  await launch();
  assert.equal(
    await manager.locator("#cloud-new, #cloud-apply, #cloud-local").count(),
    0,
  );
  assert.equal((await status()).value.configured, false);
  const settings = {
    provider: "jev",
    endpoint,
    model: "jev-latest",
    timeoutSeconds: 30,
    fallback: false,
  };
  const input = {
    state: "Astronomy",
    questions: { yes: { type: "noul", instructions: "Astronomy?" } },
  };
  const missing = await manager.evaluate(
    ({ settings, input }) =>
      chrome.runtime.sendMessage({
        type: "jev-cloud-evaluate",
        requestId: crypto.randomUUID(),
        settings,
        input,
      }),
    { settings, input },
  );
  assert.equal(missing.code, "API_KEY_NOT_CONFIGURED");
  assert.equal(report.requests, 0);
  ok("missing API keys block requests with API_KEY_NOT_CONFIGURED");

  // Disposable profile host preapproval; the UI still calls real permissions.request.
  const chromeSettings = await context.newPage();
  await chromeSettings.goto("chrome://extensions/");
  await chromeSettings.evaluate(
    (id) => chrome.developerPrivate.addHostPermission(id, "http://127.0.0.1/*"),
    extensionId,
  );
  await chromeSettings.close();
  await inContent(() => {
    globalThis.byokStorageEvents = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") byokStorageEvents.push(JSON.stringify(changes));
    });
  });
  await manager.locator("#cloud-endpoint").fill(endpoint);
  await manager.locator("#cloud-key").fill(initialKey);
  await manager.locator("#cloud-timeout").fill("30");
  await manager.locator("#cloud-fallback").uncheck();
  await manager.locator("#cloud-key-save").click();
  await manager.waitForFunction(
    () =>
      !!document.querySelector('#models [data-cloud-id][data-active="true"]'),
  );
  assert.equal(await manager.locator("#cloud-key").inputValue(), "");
  assert.doesNotMatch(JSON.stringify(await status()), /persist-only-test-key/);
  assert.doesNotMatch(
    await manager.evaluate(() => JSON.stringify(localStorage)),
    /persist-only-test-key/,
  );
  assert.doesNotMatch(
    await manager.locator("body").innerText(),
    /persist-only-test-key/,
  );
  const worker = context
    .serviceWorkers()
    .find((worker) => worker.url().endsWith("/launch.js"));
  assert.ok(worker);
  assert.equal(
    await worker.evaluate(
      async (keyName) =>
        (await chrome.storage.local.get(keyName))[keyName].profiles[0].apiKey,
      keyName,
    ),
    initialKey,
  );
  ok(
    "UI saves a key to storage.local, clears its input, exposes only configured status, and the worker can read it",
  );

  const access = await inContent(async (keyName) => {
    try {
      return { data: await chrome.storage.local.get(keyName) };
    } catch {
      return { denied: true };
    }
  }, keyName);
  assert.equal(access.denied, true, JSON.stringify(access));
  const denied = await inContent(
    async ({ settings, input }) => {
      const responses = [];
      for (const message of [
        { type: "jev-cloud-status" },
        { type: "jev-cloud-save", settings, apiKey: "malicious-overwrite" },
        { type: "jev-cloud-delete" },
        {
          type: "jev-cloud-evaluate",
          requestId: "malicious",
          settings,
          input,
          url: "https://unrelated.example/collect",
          headers: { Authorization: "anything" },
        },
      ])
        responses.push(await chrome.runtime.sendMessage(message));
      return responses;
    },
    { settings, input },
  );
  assert.ok(denied.every((response) => response.code === "INVALID_REQUEST"));
  assert.equal(report.requests, 0);
  assert.deepEqual(await inContent(() => byokStorageEvents), []);
  ok(
    "content scripts cannot read storage.local or credential change events, manage keys or request an arbitrary authenticated proxy",
  );

  await manager.locator("#cloud-test").click();
  await manager.waitForFunction(() =>
    document.querySelector("#cloud-status").textContent.includes("接続成功"),
  );
  assert.equal(report.requests, 1);
  await manager.waitForFunction(() =>
    document.querySelector("#cloud-active").textContent.includes("JEV互換API"),
  );
  await fillSingleCriterion(manager);
  assert.equal((await runEvaluation(manager)).response.model, "byok-fixture");
  ok(
    "connection testing and normal inference use the saved key through the service worker without page-side fetch",
  );

  await context.close();
  context = undefined;
  report.browserRestarts++;
  await launch();
  assert.equal((await status()).value.configured, true);
  assert.equal(await manager.locator("#cloud-key").inputValue(), "");
  assert.equal(await manager.locator("#cloud-endpoint").inputValue(), endpoint);
  assert.match(await manager.locator("#cloud-active").innerText(), /ローカル/);
  await manager.locator('[data-cloud-action="select"]').click();
  await manager.waitForFunction(() =>
    document.querySelector("#cloud-active").textContent.includes("JEV互換API"),
  );
  await fillSingleCriterion(manager);
  assert.equal((await runEvaluation(manager)).response.model, "byok-fixture");
  ok(
    "fully closing and restarting Chromium preserves the key; the default stays local and selecting cloud needs no re-entry",
  );

  await navigate(manager, "models");
  await manager
    .locator("#cloud-endpoint")
    .fill("https://unrelated.example/api");
  const before = report.requests;
  const changed = await manager.evaluate(
    (settings) =>
      chrome.runtime.sendMessage({
        type: "jev-cloud-save",
        settings,
        apiKey: "",
      }),
    { ...settings, endpoint: "https://unrelated.example/api" },
  );
  assert.equal(changed.code, "API_KEY_NOT_CONFIGURED");
  assert.equal(report.requests, before);
  await manager.locator("#cloud-endpoint").fill(endpoint);
  await manager.locator("#cloud-key").fill(replacementKey);
  await manager.locator("#cloud-key-save").click();
  await manager.waitForFunction(
    () =>
      document.querySelector("#cloud-key").value === "" &&
      !document.querySelector("#cloud-key-save").disabled,
  );
  expectedKey = replacementKey;
  const replaced = await manager.evaluate(() =>
    chrome.storage.local.get("jev-cloud-credentials:v1"),
  );
  assert.doesNotMatch(JSON.stringify(replaced), /persist-only-test-key/);
  await manager.locator("#cloud-test").click();
  await manager.waitForFunction(() =>
    document.querySelector("#cloud-status").textContent.includes("接続成功"),
  );
  ok(
    "changing endpoints cannot reuse a saved key; replacement uses only the new key and retains no key history",
  );

  for (const [next, pattern] of [
    ["authentication", /APIキーを確認/],
    ["limited", /利用上限|レート制限/],
    ["server", /HTTP 503/],
    ["echo", /認証情報/],
  ]) {
    mode = next;
    await manager.locator("#cloud-test").click();
    await manager.locator("#error").waitFor({ state: "visible" });
    assert.match(await manager.locator("#error").innerText(), pattern);
    assert.match(await manager.locator("#cloud-status").innerText(), pattern);
    assert.doesNotMatch(
      await manager.locator("body").innerText(),
      /persist-only-test-key|replacement-test-key|Bearer/,
    );
  }
  mode = "success";
  await manager
    .locator('[aria-labelledby="cloud-heading"]')
    .screenshot({ path: ".test-artifacts/byok-settings.png" });
  ok(
    "authentication, rate-limit, HTTP and credential-echo errors are distinct and never display keys or provider error bodies",
  );

  await manager.locator('[data-cloud-action="remove"]').click();
  await manager
    .locator("#models [data-cloud-id]")
    .waitFor({ state: "detached" });
  await manager.waitForFunction(
    () =>
      document.querySelector("#cloud-key-state").textContent ===
      "APIキー未設定",
  );
  assert.deepEqual(
    await manager.evaluate(() =>
      chrome.storage.local.get("jev-cloud-credentials:v1"),
    ),
    {},
  );
  assert.equal((await status()).value.configured, false);
  const deleted = await manager.evaluate(
    ({ settings, input }) =>
      chrome.runtime.sendMessage({
        type: "jev-cloud-evaluate",
        requestId: crypto.randomUUID(),
        settings,
        input,
      }),
    { settings, input },
  );
  assert.equal(deleted.code, "API_KEY_NOT_CONFIGURED");
  assert.doesNotMatch(
    logs.join("\n"),
    /persist-only-test-key|replacement-test-key|Bearer /,
  );
  assert.deepEqual(report.errors, []);
  ok(
    "deletion removes stored credentials and blocks subsequent calls; captured browser console output contains no keys or authorization headers",
  );

  expectedKey = initialKey;
  await manager.locator("#cloud-name").fill("JEV One");
  await manager.locator("#cloud-endpoint").fill(endpoint);
  await manager.locator("#cloud-model").fill("jev-latest");
  await manager.locator("#cloud-key").fill(initialKey);
  await manager.locator("#cloud-fallback").uncheck();
  await manager.locator("#cloud-key-save").click();
  await manager.locator("#models [data-cloud-id]").waitFor();
  const firstId = (await status()).value.profiles[0].id;
  await manager.locator("#cloud-name").fill("JEV Two");
  await manager.locator("#cloud-endpoint").fill(endpoint + "-two");
  await manager.locator("#cloud-model").fill(secondModel);
  await manager.locator("#cloud-key").fill(secondKey);
  await manager.locator("#cloud-key-save").click();
  await manager.waitForFunction(
    () => document.querySelectorAll("#models [data-cloud-id]").length === 2,
  );
  const secondId = (await status()).value.profiles[1].id;
  const firstRow = () => manager.locator(`[data-cloud-id="${firstId}"]`);
  const secondRow = () => manager.locator(`[data-cloud-id="${secondId}"]`);
  await manager.waitForFunction(() =>
    document.querySelector("#cloud-active").textContent.includes("JEV Two"),
  );
  await fillSingleCriterion(manager);
  assert.equal(
    (await runEvaluation(manager)).response.model,
    "byok-second-fixture",
  );
  await navigate(manager, "models");
  await firstRow().locator('[data-cloud-action="edit"]').click();
  assert.equal(await manager.locator("#cloud-name").inputValue(), "JEV One");
  assert.equal(await manager.locator("#cloud-key").inputValue(), "");
  await manager.locator("#cloud-name").fill("JEV One renamed");
  await manager.locator("#cloud-timeout").fill("45");
  await manager.locator("#cloud-key-save").click();
  await manager.waitForFunction(
    () =>
      document.querySelector("#models h3").textContent === "JEV One renamed",
  );
  assert.match(
    await manager.locator("#cloud-active").innerText(),
    /JEV One renamed/,
  );
  assert.equal(await firstRow().getAttribute("data-active"), "true");
  assert.equal(await secondRow().getAttribute("data-active"), "false");
  await manager.locator("#cloud-test").click();
  await manager.waitForFunction(() =>
    document.querySelector("#cloud-status").textContent.includes("接続成功"),
  );
  ok(
    "multiple APIs appear in the model list; save registers and activates each API, and editing an entry activates its saved configuration",
  );

  await context.close();
  context = undefined;
  report.browserRestarts++;
  await launch();
  assert.equal((await status()).value.profiles.length, 2);
  assert.equal(await manager.locator("#models [data-cloud-id]").count(), 2);
  assert.match(await manager.locator("#cloud-active").innerText(), /ローカル/);
  await secondRow().locator('[data-cloud-action="select"]').click();
  await manager.waitForFunction(() =>
    document.querySelector("#cloud-active").textContent.includes("JEV Two"),
  );
  await fillSingleCriterion(manager);
  assert.equal(
    (await runEvaluation(manager)).response.model,
    "byok-second-fixture",
  );
  await navigate(manager, "models");
  await secondRow().locator('[data-cloud-action="edit"]').click();
  secondModel = "jev-two-updated";
  await manager.locator("#cloud-model").fill(secondModel);
  await manager.locator("#cloud-timeout").fill("20");
  await manager.locator("#cloud-key-save").click();
  await manager.waitForFunction(() =>
    document
      .querySelector("#cloud-active")
      .textContent.includes("jev-two-updated"),
  );
  assert.equal(await manager.locator("#cloud-key").inputValue(), "");
  await navigate(manager, "judge");
  assert.equal(
    (await runEvaluation(manager)).response.model,
    "byok-second-fixture",
  );
  await navigate(manager, "models");
  await manager
    .locator('[aria-labelledby="model-heading"]')
    .screenshot({ path: ".test-artifacts/cloud-model-list.png" });
  ok(
    "all API profiles and keys survive a full browser restart; editing the selected API applies the new model without re-entering its key",
  );

  await secondRow().locator('[data-cloud-action="remove"]').click();
  await secondRow().waitFor({ state: "detached" });
  assert.match(await manager.locator("#cloud-active").innerText(), /ローカル/);
  assert.equal((await status()).value.profiles.length, 1);
  await firstRow().locator('[data-cloud-action="select"]').click();
  await manager.waitForFunction(() =>
    document
      .querySelector("#cloud-active")
      .textContent.includes("JEV One renamed"),
  );
  await navigate(manager, "judge");
  assert.equal((await runEvaluation(manager)).response.model, "byok-fixture");
  await navigate(manager, "models");
  assert.doesNotMatch(
    JSON.stringify(await status()),
    /persist-only-test-key|second-profile-test-key/,
  );
  const remaining = await manager.evaluate(() =>
    chrome.storage.local.get("jev-cloud-credentials:v1"),
  );
  assert.doesNotMatch(JSON.stringify(remaining), /second-profile-test-key/);
  assert.doesNotMatch(
    logs.join("\n"),
    /persist-only-test-key|replacement-test-key|second-profile-test-key|Bearer /,
  );
  assert.deepEqual(report.errors, []);
  ok(
    "deleting the selected API returns to local, removes only its key and leaves the other API usable from the list",
  );
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    ".test-artifacts/byok-report.json",
    JSON.stringify(report, null, 2),
  );
}
