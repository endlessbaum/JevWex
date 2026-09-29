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
const report = {
  passed: [],
  errors: [],
  notRun: [
    "ツールバーの実クリックによるactiveTab付与",
    "Chromeのネイティブ許可ダイアログの実クリック（許可対象をテスト用Chromeのサイト設定に追加してから本物のpermissions.requestを実行）",
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
  await context.route(
    /^https:\/\/(huggingface\.co|example\.org)\/capture-test\//,
    (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop();
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<html><head><title>${name}</title></head><body>${name === "empty" ? "" : `<h1>${name}</h1><p>本文 ${name}</p><p hidden>HIDDEN SECRET</p>`}</body></html>`,
      });
    },
  );
  const app = await context.newPage();
  await app.goto(`chrome-extension://${id}/index.html`);
  const source = await context.newPage();
  const firstUrl = "https://huggingface.co/capture-test/first";
  await source.goto(firstUrl);
  await source.bringToFront();
  await app.evaluate(async () => {
    const window = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: window.id });
  });
  let target;
  for (let n = 0; n < 100 && !target; n++) {
    target = (await cdp.send("Target.getTargets")).targetInfos.find(
      (target) => target.url === `chrome-extension://${id}/panel.html`,
    );
    if (!target) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(target, "native side panel target exists");
  // Playwright does not expose native side-panel targets as Page objects.
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: false,
  });
  let commandId = 0;
  const pending = new Map();
  cdp.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.method === "Runtime.exceptionThrown")
      report.errors.push(JSON.stringify(message.params));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  async function evaluate(fn, arg) {
    const id = ++commandId;
    const result = new Promise((resolve) => pending.set(id, resolve));
    await cdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression: `(${fn})(${JSON.stringify(arg) ?? "undefined"})`,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
      }),
    });
    const message = await result;
    assert.equal(message.error, undefined);
    assert.equal(message.result.exceptionDetails, undefined);
    return message.result.result.value;
  }
  const panel = {
    async waitForFunction(fn, arg) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await evaluate(fn, arg)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(
        `Panel condition timed out: ${fn}\n${await evaluate(() => document.body.innerText)}`,
      );
    },
    locator(selector) {
      return {
        textContent: () =>
          evaluate(
            (selector) => document.querySelector(selector).textContent,
            selector,
          ),
        isDisabled: () =>
          evaluate(
            (selector) => document.querySelector(selector).disabled,
            selector,
          ),
        isHidden: () =>
          evaluate(
            (selector) => document.querySelector(selector).hidden,
            selector,
          ),
        click: () =>
          evaluate(
            (selector) => document.querySelector(selector).click(),
            selector,
          ),
      };
    },
  };
  await panel.waitForFunction(
    (url) => document.querySelector("#source-url")?.textContent === url,
    firstUrl,
  );
  assert.match(
    await panel.locator("#source-preview").textContent(),
    /本文 first/,
  );
  assert.doesNotMatch(
    await panel.locator("#source-preview").textContent(),
    /HIDDEN SECRET/,
  );
  ok(
    "native side panel captures the live tab on opening without a stored action snapshot",
  );

  for (const revision of ["本文 更新1", "本文 更新2"]) {
    await source.evaluate((text) => {
      document.querySelector("p").textContent = text;
    }, revision);
    await panel.locator("#source-refresh").click();
    await panel.waitForFunction(
      (text) =>
        document.querySelector("#source-preview").textContent.includes(text) &&
        !document.querySelector("#source-refresh").disabled,
      revision,
    );
  }
  ok(
    "repeated refresh reads changed content at the same URL without reopening the panel",
  );

  const second = await context.newPage();
  const secondUrl = "https://huggingface.co/capture-test/second";
  await second.goto(secondUrl);
  await second.bringToFront();
  await panel.waitForFunction(
    (url) => document.querySelector("#source-url").textContent === url,
    secondUrl,
  );
  assert.match(
    await panel.locator("#source-preview").textContent(),
    /本文 second/,
  );
  await source.bringToFront();
  await panel.waitForFunction(
    (url) => document.querySelector("#source-url").textContent === url,
    firstUrl,
  );
  ok("switching tabs updates the URL and text automatically");

  await source.goto("https://huggingface.co/capture-test/next");
  await panel.waitForFunction(() =>
    document.querySelector("#source-preview").textContent.includes("本文 next"),
  );
  await source.evaluate(() => {
    document.querySelector("p").textContent = "本文 SPA";
    history.pushState(null, "", "/capture-test/spa");
  });
  await panel.waitForFunction(
    () =>
      document.querySelector("#source-url").textContent.endsWith("/spa") &&
      document
        .querySelector("#source-preview")
        .textContent.includes("本文 SPA"),
  );
  ok("full navigation and SPA URL changes replace the capture");

  await source.goto("https://example.org/capture-test/no-permission");
  await panel.waitForFunction(() =>
    document.querySelector("#error").textContent.includes("読み取り権限"),
  );
  assert.equal(await panel.locator("#source-preview").textContent(), "");
  assert.equal(await panel.locator("#source-url").textContent(), "");
  assert.equal(await panel.locator("#run").isDisabled(), true);
  assert.equal(await panel.locator("#new-rule").isDisabled(), true);
  assert.match(
    await panel.locator("#source-refresh").textContent(),
    /許可して再取得/,
  );
  assert.equal(
    await app.evaluate(() =>
      chrome.permissions.contains({ origins: ["https://example.org/*"] }),
    ),
    false,
  );
  // Simulate denial without interacting with a native Chrome dialog.
  await evaluate(() => {
    globalThis.originalPermissionRequest = chrome.permissions.request;
    chrome.permissions.request = async () => false;
  });
  await panel.locator("#source-refresh").click();
  await panel.waitForFunction(
    () => !document.querySelector("#source-refresh").disabled,
  );
  assert.match(await panel.locator("#error").textContent(), /許可されなかった/);
  assert.equal(await panel.locator("#source-preview").textContent(), "");
  await evaluate(() => {
    chrome.permissions.request = globalThis.originalPermissionRequest;
  });
  ok(
    "a site without activeTab permission offers access recovery; declining does not capture or strand the button",
  );

  await evaluate(() => {
    chrome.permissions.request = () =>
      new Promise((resolve) => {
        globalThis.resolvePermissionRequest = resolve;
      });
  });
  await panel.locator("#source-refresh").click();
  assert.equal(await panel.locator("#source-refresh").isDisabled(), true);
  await second.bringToFront();
  await panel.waitForFunction(
    (url) => document.querySelector("#source-url").textContent === url,
    secondUrl,
  );
  await evaluate(async () => {
    globalThis.resolvePermissionRequest(false);
    await Promise.resolve();
    chrome.permissions.request = globalThis.originalPermissionRequest;
  });
  assert.equal(await panel.locator("#error").isHidden(), true);
  assert.match(
    await panel.locator("#source-preview").textContent(),
    /本文 second/,
  );
  await source.bringToFront();
  await panel.waitForFunction(() =>
    document
      .querySelector("#source-refresh")
      .textContent.includes("許可して再取得"),
  );
  ok(
    "a permission response arriving after a tab switch cannot overwrite the new page capture",
  );

  // Pre-approve only this host through Chrome's own site settings in this
  // disposable test profile. permissions.request must still activate the
  // optional permission; contains() remains false until the panel requests it.
  const settings = await context.newPage();
  await settings.goto("chrome://extensions/");
  await settings.evaluate(
    (id) =>
      chrome.developerPrivate.addHostPermission(id, "https://example.org/*"),
    id,
  );
  await settings.close();
  await source.bringToFront();
  await panel.waitForFunction(
    () =>
      document
        .querySelector("#source-refresh")
        .textContent.includes("許可して再取得") &&
      !document.querySelector("#source-refresh").disabled,
  );
  assert.equal(
    await app.evaluate(() =>
      chrome.permissions.contains({ origins: ["https://example.org/*"] }),
    ),
    false,
  );
  await panel.locator("#source-refresh").click();
  await panel.waitForFunction(
    () =>
      document
        .querySelector("#source-preview")
        .textContent.includes("本文 no-permission") &&
      !document.querySelector("#source-refresh").disabled,
  );
  assert.equal(
    await app.evaluate(() =>
      chrome.permissions.contains({ origins: ["https://example.org/*"] }),
    ),
    true,
  );
  assert.equal(
    await app.evaluate(() =>
      chrome.permissions.contains({ origins: ["https://unrelated.example/*"] }),
    ),
    false,
  );
  assert.equal(await panel.locator("#error").isHidden(), true);
  await source.evaluate(() => {
    document.querySelector("p").textContent = "本文 許可後の更新";
  });
  await panel.locator("#source-refresh").click();
  await panel.waitForFunction(() =>
    document
      .querySelector("#source-preview")
      .textContent.includes("本文 許可後の更新"),
  );
  ok(
    "refresh grants only the current host through real permissions.request, captures immediately, and works again without reopening",
  );

  await source.goto("https://huggingface.co/capture-test/empty");
  await panel.waitForFunction(() =>
    document
      .querySelector("#error")
      .textContent.includes("読み取れる文章がありません"),
  );
  assert.equal(await panel.locator("#run").isDisabled(), true);
  ok(
    "empty page content is explained instead of silently disabling evaluation",
  );

  await app.bringToFront();
  await panel.waitForFunction(() =>
    document.querySelector("#error").textContent.includes("取得対象外"),
  );
  assert.equal(await panel.locator("#source-preview").textContent(), "");
  await second.bringToFront();
  await panel.waitForFunction(
    (url) => document.querySelector("#source-url").textContent === url,
    secondUrl,
  );
  assert.equal(await panel.locator("#error").isHidden(), true);
  ok(
    "management tabs clear the source; returning to a readable web tab restores it",
  );
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.errors.push(String(error));
  throw error;
} finally {
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/capture-test-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await context.close();
}
