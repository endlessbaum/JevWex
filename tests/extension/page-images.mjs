import { loadModel } from "./ui-helpers.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { build } from "esbuild";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const real = process.env.JEV_PAGE_IMAGE_REAL === "1";
const context = await chromium.launchPersistentContext(
  real ? resolve(".test-artifacts/vision-profile") : "",
  {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  },
);
context.setDefaultTimeout(15000);
const report = { passed: [], errors: [], realModel: real };
const ok = (name) => {
  report.passed.push(name);
  console.log("PASS", name);
};
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist"),
  });
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/index.html`);
  await manager.evaluate(() =>
    chrome.permissions.remove({ origins: ["https://i.ytimg.com/*"] }),
  );
  const bundle = await build({
    stdin: {
      contents:
        'export {pageContent} from "./src/extension/content-scope"; export {loadPageImages} from "./src/extension/page-images";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "imageTest",
  });
  await manager.evaluate(
    bundle.outputFiles[0].text + ";globalThis.imageTest=imageTest;",
  );
  const colors = await manager.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    return ["red", "blue", "green"].map((color) => {
      canvas.getContext("2d").fillStyle = color;
      canvas.getContext("2d").fillRect(0, 0, 64, 64);
      return canvas.toDataURL("image/webp");
    });
  });
  const url = "https://huggingface.co/page-images-test";
  await manager.evaluate(async (url) => {
    const keys = Object.entries(await chrome.storage.local.get(null))
      .filter(
        ([key, value]) => key.startsWith("jev-site-rule:") && value.url === url,
      )
      .map(([key]) => key);
    await chrome.storage.local.remove(keys);
  }, url);
  await context.route("https://i.ytimg.com/**", (route) =>
    route.fulfill({
      contentType: "image/webp",
      body: Buffer.from(colors[0].split(",")[1], "base64"),
    }),
  );
  await context.route("https://huggingface.co/image-test-*.webp", (route) => {
    const color = route.request().url().includes("blue")
      ? colors[1]
      : colors[0];
    return route.fulfill({
      contentType: "image/webp",
      body: Buffer.from(color.split(",")[1], "base64"),
    });
  });
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
    <html><head><title>サムネイル判定</title><style>body{font:18px system-ui}img{width:96px;height:96px}li{padding:16px}main{width:50%}</style></head>
    <body><main><ul id="cards"><li><img id="red" alt="thumbnail one" src="https://huggingface.co/image-test-red.webp"><small><img src="${colors[2]}" alt="avatar"></small></li><li><picture><source srcset="https://huggingface.co/image-test-blue.webp"><img id="blue" src="${colors[0]}" alt="thumbnail two"></picture><small><img src="${colors[2]}" alt="avatar"></small></li><li style="display:none"><img src="${colors[2]}"></li></ul><img id="embedded" src="${colors[0]}"><img id="denied" src="https://i.ytimg.com/vi/test/hqdefault.jpg"><section id="text">Text only</section></main></body></html>`,
    }),
  );
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/panel.html`);
  const source = await context.newPage();
  await source.goto(url);
  await source.bringToFront();
  await panel.waitForFunction(() =>
    document
      .querySelector("#source-url")
      .textContent.includes("page-images-test"),
  );
  const tabId = await manager.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id,
    url,
  );
  const capture = (scope) =>
    manager.evaluate(
      async ({ tabId, scope }) => {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func: imageTest.pageContent,
          args: [scope, false],
        });
        return injection.result;
      },
      { tabId, scope },
    );
  const scope = {
    root: "#cards",
    exclude: [],
    items: ":scope > li",
    images: true,
    sharedExclude: [
      {
        container: "#cards",
        items: ":scope > li",
        path: ":scope > small:nth-of-type(1)",
      },
    ],
  };
  let snapshot = await capture(scope);
  assert.equal(snapshot.items.length, 2);
  assert.deepEqual(
    snapshot.items.map((i) => i.images.map((img) => img.url)),
    [
      ["https://huggingface.co/image-test-red.webp"],
      ["https://huggingface.co/image-test-blue.webp"],
    ],
  );
  assert.equal(snapshot.items[0].text, "");
  assert.deepEqual(snapshot.images, []);
  ok(
    "image-only repeated items preserve currentSrc and shared exclusions, skipping hidden images",
  );
  assert.equal(
    (await capture({ root: "#red", exclude: [], images: true })).images.length,
    1,
  );
  assert.equal(
    (await capture({ root: "#cards", exclude: [] })).images,
    undefined,
  );
  ok(
    "standalone img captures without text; existing text targets do not gain image inputs",
  );

  const loaded = await manager.evaluate(
    async (images) => {
      const output = await imageTest.loadPageImages(
        images,
        new AbortController().signal,
      );
      return Promise.all(
        output.map(async (image) => {
          const bitmap = await createImageBitmap(
            new Blob([image.data], { type: image.type }),
          );
          const canvas = new OffscreenCanvas(image.width, image.height),
            ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          return {
            type: image.type,
            width: image.width,
            pixel: [...ctx.getImageData(0, 0, 1, 1).data],
          };
        }),
      );
    },
    [
      snapshot.items[0].images[0],
      snapshot.items[1].images[0],
      { url: colors[0], label: "embedded" },
    ],
  );
  assert.equal(loaded[0].type, "image/png");
  assert.equal(loaded[0].width, 64);
  assert.ok(loaded[0].pixel[0] > 200 && loaded[0].pixel[2] < 20);
  assert.ok(loaded[1].pixel[2] > 200 && loaded[1].pixel[0] < 20);
  assert.ok(loaded[2].pixel[0] > 200);
  ok("actual HTTP and embedded WebP decode to distinct PNG pixels for the VLM");
  const denied = await manager.evaluate(async () => {
    try {
      await imageTest.loadPageImages(
        [{ url: "https://i.ytimg.com/vi/test/hqdefault.jpg", label: "thumb" }],
        new AbortController().signal,
      );
    } catch (error) {
      return error.message;
    }
  });
  assert.match(denied, /未許可/);
  ok("ungranted thumbnail host fails explicitly before download");

  // Exercise the real target-edit UI, including automatically enabling an img root.
  await panel.locator("#new-rule").click();
  await panel.locator("#create-name").fill("画像だけ");
  await panel
    .locator('#create-criteria [data-field="instructions"]')
    .fill("Is the image predominantly red?");
  await panel.evaluate(() =>
    document.querySelector("#create-target-edit").click(),
  );
  await source.locator("[data-jev-scope-editor]").waitFor();
  const sourceCDP = await context.newCDPSession(source);
  const shadow = async (attribute, fn, arg) => {
    const { root } = await sourceCDP.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (node) =>
      node.attributes?.includes(attribute)
        ? node.shadowRoots?.[0]
        : (node.children ?? []).map(find).find(Boolean);
    const { object } = await sourceCDP.send("DOM.resolveNode", {
      backendNodeId: find(root).backendNodeId,
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
  };
  await shadow("data-jev-scope-editor", (root) => {
    const row = root
      .querySelector('input[aria-label="img#deniedを含める"]')
      .closest("summary");
    [...row.querySelectorAll("button")]
      .find((b) => b.textContent === "この要素以下に絞る")
      .click();
  });
  assert.equal(
    await shadow(
      "data-jev-scope-editor",
      (root) => root.querySelector("[data-scope-images]").checked,
    ),
    true,
  );
  await shadow("data-jev-scope-editor", (root) =>
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === "この対象を使う")
      .click(),
  );
  await source
    .locator("[data-jev-scope-editor]")
    .waitFor({ state: "detached" });
  await panel
    .getByRole("button", { name: "画像の取得元を許可", exact: true })
    .waitFor();
  assert.match(
    await panel.locator("#create-fields").textContent(),
    /https:\/\/i.ytimg.com\/\*/,
  );
  const settings = await context.newPage();
  await settings.goto("chrome://extensions/");
  await settings.evaluate(
    (id) =>
      chrome.developerPrivate.addHostPermission(id, "https://i.ytimg.com/*"),
    id,
  );
  await settings.close();
  await source.bringToFront();
  await panel
    .getByRole("button", { name: "画像の取得元を許可", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "画像の取得元を許可", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    await manager.evaluate(() =>
      chrome.permissions.contains({ origins: ["https://i.ytimg.com/*"] }),
    ),
    true,
  );
  assert.equal(
    await manager.evaluate(() =>
      chrome.permissions.contains({ origins: ["https://unrelated.example/*"] }),
    ),
    false,
  );
  const cdnImage = await manager.evaluate(async () => {
    const [image] = await imageTest.loadPageImages(
      [
        {
          url: "https://i.ytimg.com/vi/red-test/hqdefault.jpg",
          label: "thumbnail",
        },
      ],
      new AbortController().signal,
    );
    return { width: image.width, size: image.size };
  });
  assert.equal(cdnImage.width, 64);
  assert.ok(cdnImage.size > 0);
  ok(
    "real permissions.request grants only the chosen CDN and CSP permits its image fetch (fixture response)",
  );
  await panel.locator("#create-save").click();
  await panel.locator("#create-condition").waitFor({ state: "hidden" });
  const saved = await manager.evaluate(async () =>
    Object.entries(await chrome.storage.local.get(null))
      .filter(([key]) => key.startsWith("jev-site-rule:"))
      .map(([, rule]) => rule)
      .find((r) => r.name === "画像だけ"),
  );
  assert.equal(saved.contentScope.images, true);
  assert.equal(saved.contentScope.root, "#denied");
  ok(
    "selecting img enables image mode, exposes exact CDN permission and saves target with criteria",
  );
  await manager.evaluate(
    async ({ saved, scope, url }) => {
      await chrome.storage.local.set({
        [`jev-site-rule:${saved.id}`]: { ...saved, url, contentScope: scope },
      });
    },
    { saved, scope, url },
  );
  await panel.close();
  await source.locator("#red").evaluate((img) => {
    img.src = "https://i.ytimg.com/vi/red-test/hqdefault.jpg";
  });

  if (real) {
    await manager.locator("#nav-models").click();
    await manager.waitForFunction(() =>
      [...document.querySelectorAll("#models > li")].some((o) =>
        /LFM2.5-VL/.test(o.textContent),
      ),
    );
    const value = await manager
      .locator("#models")
      .evaluate(
        (el) =>
          [...el.children].find((o) => /LFM2.5-VL/.test(o.textContent)).dataset
            .modelId,
      );
    await loadModel(manager, value);
    await manager.waitForFunction(
      () =>
        document
          .querySelector("#image-hint")
          .textContent.includes("現在のモデルは画像に対応"),
      null,
      { timeout: 200000 },
    );
  } else {
    await manager.evaluate(() => {
      globalThis.imageRequests = [];
      globalThis.textModel = false;
      const channel = new BroadcastChannel("jev-web-page-judge-v1");
      channel.onmessage = ({ data }) => {
        if (data.type === "hello")
          channel.postMessage({
            type: "status",
            status: {
              id: "images-test",
              ready: true,
              supportsImages: !globalThis.textModel,
              model: "test",
              phase: "ready",
            },
          });
        if (data.type !== "evaluate") return;
        imageRequests.push(data.request);
        channel.postMessage({
          type: "result",
          ...data.request,
          result: {
            evaluation: {
              response: { answers: { a: { type: "noul", noul: 0.5 } } },
            },
            presentation: { a: { alias: "test", labels: [] } },
          },
        });
      };
    });
  }
  const run = async () => {
    const { jobId } = await manager.evaluate(
      (tabId) =>
        chrome.runtime.sendMessage({
          type: "jev-run-page",
          tabId,
          mode: "auto",
        }),
      tabId,
    );
    assert.ok(jobId);
    for (let n = 0; n < 1200; n++) {
      const state = await manager.evaluate(
        async (tabId) =>
          (await chrome.storage.session.get(`jev-page-job:${tabId}`))[
            `jev-page-job:${tabId}`
          ],
        tabId,
      );
      if (state?.jobId === jobId && state.phase !== "running") return state;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("job timed out");
  };
  const state = await run();
  assert.equal(state.phase, "complete");
  assert.doesNotMatch(state.message, /失敗/);
  if (!real) {
    const requests = await manager.evaluate(() => imageRequests);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].text, "");
    assert.match(requests[0].images[0].url, /red/);
    assert.match(requests[1].images[0].url, /blue/);
  }
  report.overlay = await shadow("data-jev-overlay", (root) => root.textContent);
  await source.screenshot({ path: ".test-artifacts/page-images-overlay.png" });
  ok(
    real
      ? "cached LFM2.5-VL performs real image-only page judgments per item with panel closed"
      : "panel-closed runner sends separate image-only requests and renders results on the page",
  );
  if (!real) {
    await manager.evaluate(() => {
      globalThis.textModel = true;
      globalThis.imageRequests = [];
    });
    const failed = await run();
    assert.match(failed.message, /失敗 2件/);
    assert.equal((await manager.evaluate(() => imageRequests)).length, 0);
    assert.match(
      await shadow("data-jev-overlay", (root) => root.textContent),
      /画像を読み取れません/,
    );
    ok(
      "text-only models reject image inputs visibly without silently ignoring them",
    );
  }
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  throw error;
} finally {
  await mkdir("docs", { recursive: true });
  await writeFile(
    `docs/page-images${real ? "-real" : ""}-test-results.json`,
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
