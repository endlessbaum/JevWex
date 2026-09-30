import assert from "node:assert/strict";
import { chromium } from "playwright";
import { build } from "esbuild";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging"],
});
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
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/index.html`);
  const bundle = await build({
    stdin: {
      contents:
        'export {pageContent} from "./src/extension/content-scope"; export {renderOverlay} from "./src/extension/overlay";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "targetsTest",
  });
  await manager.evaluate(
    bundle.outputFiles[0].text + ";globalThis.targetsTest=targetsTest;",
  );
  const url = "https://huggingface.co/result-targets-test";
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
    <html><head><style>body{margin:20px;font:18px system-ui}main{width:55%}li,section{padding:20px;border:1px solid #aaa;margin:12px 0;min-height:100px}#spacer{height:1600px}#nested{height:200px;overflow:auto}#nested-space{height:600px}</style></head>
    <body><main><h1>判定した要素</h1><div id="spacer"></div><ul id="list"><li>ONE</li><li>TWO</li></ul><section id="combined">COMBINED</section><div id="nested"><div id="nested-space"></div><img id="picture" width="80" height="80" alt="IMAGE" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='blue'/%3E%3C/svg%3E"></div><div style="height:1000px"></div></main></body></html>`,
    }),
  );
  const source = await context.newPage();
  await source.goto(url);
  const tabId = await manager.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id,
    url,
  );
  const capture = (scope) =>
    manager.evaluate(
      async ({ tabId, scope }) => {
        const [value] = await chrome.scripting.executeScript({
          target: { tabId },
          func: targetsTest.pageContent,
          args: [scope],
        });
        return value.result;
      },
      { tabId, scope },
    );
  const list = await capture({
    root: "#list",
    exclude: [],
    items: ":scope > li",
  });
  const combined = await capture({ root: "#combined", exclude: [] });
  const picture = await capture({
    root: "#picture",
    exclude: [],
    images: true,
  });
  const results = [
    ...list.items.map((item) => ({
      name: "項目",
      item,
      target: item.target,
      answers: [{ name: "基準", value: "50%", details: [] }],
    })),
    { name: "まとめて判定", target: combined.target, answers: [] },
    { name: "画像判定", target: picture.target, answers: [] },
  ];
  const data = {
    jobId: "hover-test",
    url,
    phase: "running",
    message: "判定中",
    results,
  };
  const render = (data) =>
    manager.evaluate(
      async ({ tabId, data }) => {
        const [value] = await chrome.scripting.executeScript({
          target: { tabId },
          func: targetsTest.renderOverlay,
          args: [data],
        });
        return value.result;
      },
      { tabId, data },
    );
  await render(data);
  const sourceCDP = await context.newCDPSession(source);
  const shadow = async (fn, arg) => {
    const { root } = await sourceCDP.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (node) =>
      node.attributes?.includes("data-jev-overlay")
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
  const hover = async (index) => {
    const rect = await shadow((root, index) => {
      const section = root.querySelector(`[data-result-index="${index}"]`);
      section.scrollIntoView({ block: "nearest" });
      const r = section.getBoundingClientRect();
      return { x: r.left + 15, y: r.top + 15 };
    }, index);
    await source.mouse.move(5, 5);
    await source.mouse.move(rect.x, rect.y);
  };
  const toggleResults = async () => {
    const point = await shadow((root) => {
      const rect = root.querySelector(".collapse").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await source.mouse.click(point.x, point.y);
  };
  const highlight = () =>
    shadow((root) => {
      const el = root.querySelector(".target-highlight"),
        rect = el.getBoundingClientRect();
      return {
        hidden: el.hidden,
        top: rect.top,
        left: rect.left,
        height: rect.height,
        text: el.textContent,
      };
    });
  await hover(0);
  assert.ok(await source.evaluate(() => scrollY > 1000));
  let marker = await highlight();
  const firstTop = await source
    .locator("#list li")
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);
  assert.equal(marker.hidden, false);
  assert.ok(Math.abs(marker.top - firstTop + 3) < 1);
  assert.match(marker.text, /1件目/);
  await source.mouse.move(5, 5);
  assert.equal((await highlight()).hidden, true);
  ok(
    "real mouse hover scrolls to the matching offscreen list element, highlights it, and clears on leave",
  );

  await source.evaluate(() =>
    document
      .querySelector("#list")
      .prepend(document.querySelector("#list").lastElementChild),
  );
  await hover(0);
  const reorderedTop = await source
    .locator("#list li")
    .last()
    .evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(Math.abs((await highlight()).top - reorderedTop + 3) < 1);
  ok(
    "DOM reordering keeps the result attached to the original element, not its old nth-child position",
  );

  await hover(2);
  assert.ok(
    Math.abs(
      (await highlight()).top -
        (await source
          .locator("#combined")
          .evaluate((el) => el.getBoundingClientRect().top)) +
        3,
    ) < 1,
  );
  await hover(3);
  assert.ok(
    await source.locator("#nested").evaluate((el) => el.scrollTop > 400),
  );
  assert.ok(
    Math.abs(
      (await highlight()).top -
        (await source
          .locator("#picture")
          .evaluate((el) => el.getBoundingClientRect().top)) +
        3,
    ) < 1,
  );
  ok(
    "combined scope and image-only targets highlight correctly, including nested scroll containers",
  );

  await source.locator("#combined").evaluate((el) => {
    el.style.marginLeft = "900px";
    el.style.width = "200px";
  });
  await hover(2);
  assert.equal(
    await shadow(
      (root) => getComputedStyle(root.querySelector(".box")).opacity,
    ),
    "1",
  );
  for (let n = 0; n < 3; n++) {
    await render({ ...data, message: `更新 ${n}` });
    assert.equal(
      await shadow(
        (root) => getComputedStyle(root.querySelector(".box")).opacity,
      ),
      "1",
    );
    assert.equal((await highlight()).hidden, false);
  }
  await source.mouse.move(5, 5);
  assert.equal(
    await shadow(
      (root) => getComputedStyle(root.querySelector(".box")).opacity,
    ),
    "1",
  );
  await toggleResults();
  assert.equal(
    await shadow((root) => root.querySelector("#jev-result-body").hidden),
    true,
  );
  assert.equal(
    await source.locator("[data-jev-overlay]").getAttribute("data-dragging"),
    null,
  );
  assert.equal(
    await source.locator("#combined").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        ) === element
      );
    }),
    true,
  );
  await render({ ...data, message: "折りたたみ中に結果を更新" });
  await render({ ...data, phase: "complete" });
  assert.equal(
    await shadow((root) => root.querySelector("#jev-result-body").hidden),
    true,
  );
  assert.equal(
    await shadow((root) => root.activeElement?.classList.contains("collapse")),
    true,
  );
  await mkdir(".test-artifacts", { recursive: true });
  await source.screenshot({
    path: ".test-artifacts/result-overlay-collapsed.png",
  });
  await toggleResults();
  assert.equal(
    await shadow((root) => root.querySelector("#jev-result-body").hidden),
    false,
  );
  await source
    .locator("#combined")
    .evaluate((el) => el.removeAttribute("style"));
  ok(
    "overlapping results remain opaque through hover and progress updates; explicit collapse reveals clickable page content and persists until reopened",
  );

  await source.mouse.move(5, 5);
  await shadow((root) => root.querySelector('[data-result-index="1"]').focus());
  assert.equal((await highlight()).hidden, false);
  const position = await source.evaluate(() => scrollY);
  await render({
    ...data,
    message: "次の項目を判定中",
    results: [
      ...results,
      { name: "追加結果", target: combined.target, answers: [] },
    ],
  });
  assert.equal(
    await shadow((root) => root.activeElement?.dataset.resultIndex),
    "1",
  );
  assert.equal((await highlight()).hidden, false);
  assert.equal(await source.evaluate(() => scrollY), position);
  await source.evaluate(
    () => (document.querySelector("#spacer").style.height = "1650px"),
  );
  await source.waitForTimeout(60);
  assert.ok(
    Math.abs(
      (await highlight()).top -
        (await source
          .locator("#list li")
          .first()
          .evaluate((el) => el.getBoundingClientRect().top)) +
        3,
    ) < 1,
  );
  ok(
    "keyboard focus and highlight survive progress updates without scrolling again, and track layout changes",
  );

  await source.evaluate(() => {
    const node = document.querySelector("#list").firstElementChild;
    node.replaceWith(node.cloneNode(true));
  });
  await source.waitForTimeout(60);
  assert.equal((await highlight()).hidden, true);
  assert.match(
    await shadow(
      (root) => root.querySelector('[data-result-index="1"]').textContent,
    ),
    /見つかりません/,
  );
  ok(
    "removed or replaced targets show a stale-target message instead of highlighting a new element",
  );

  await shadow((root) => root.activeElement?.blur());
  await hover(2);
  await mkdir(".test-artifacts", { recursive: true });
  await source.screenshot({
    path: ".test-artifacts/result-target-highlight.png",
  });
  await shadow((root) =>
    root.querySelector('[aria-label="判定結果を閉じる"]').click(),
  );
  assert.equal(await source.locator("[data-jev-overlay]").count(), 0);
  assert.equal(await source.locator("#combined").getAttribute("style"), null);
  assert.equal(await render(data), false);
  await render({ ...data, jobId: "new-job", phase: "complete" });
  await hover(2);
  await source.keyboard.press("Escape");
  assert.equal(await source.locator("[data-jev-overlay]").count(), 0);
  ok(
    "close, escape and a new job clean up highlights without modifying the page element's styles",
  );
  const moving = { ...data, jobId: "moving", results: [results[2]] };
  await render(moving);
  const bounds = () => source.locator("[data-jev-overlay]").boundingBox();
  const grip = () =>
    shadow((root) => {
      const r = root.querySelector(".move-handle").getBoundingClientRect();
      return { x: r.left + 40, y: r.top + r.height / 2 };
    });
  const start = await bounds(),
    handle = await grip();
  await source.mouse.move(handle.x, handle.y);
  await source.mouse.down();
  await source.mouse.move(handle.x - 300, handle.y + 70, { steps: 8 });
  assert.ok(Math.abs((await bounds()).x - (start.x - 300)) < 1);
  assert.ok(Math.abs((await bounds()).y - (start.y + 70)) < 1);
  await render({
    ...moving,
    message: "ドラッグ中も判定を更新",
    results: [results[2], results[3]],
  });
  await source.mouse.move(handle.x - 400, handle.y + 100, { steps: 5 });
  await source.mouse.up();
  let moved = await bounds();
  assert.ok(Math.abs(moved.x - (start.x - 400)) < 1);
  assert.ok(Math.abs(moved.y - (start.y + 100)) < 1);
  assert.equal(
    await source.locator("[data-jev-overlay]").getAttribute("data-dragging"),
    null,
  );
  await render({ ...moving, phase: "complete" });
  assert.equal((await bounds()).x, moved.x);
  assert.equal((await bounds()).y, moved.y);
  await source.screenshot({ path: ".test-artifacts/result-overlay-moved.png" });
  ok(
    "header dragging continues across live result updates and retains its position when the job completes",
  );

  const nextHandle = await grip();
  await source.mouse.move(nextHandle.x, nextHandle.y);
  await source.mouse.down();
  await source.mouse.move(-100, -100);
  await source.mouse.up();
  assert.equal((await bounds()).x, 16);
  assert.equal((await bounds()).y, 16);
  await source.keyboard.press("ArrowRight");
  await source.keyboard.press("Shift+ArrowDown");
  assert.equal((await bounds()).x, 36);
  assert.equal((await bounds()).y, 76);
  await render({ ...moving, jobId: "moving-next", phase: "complete" });
  assert.equal((await bounds()).x, 36);
  assert.equal((await bounds()).y, 76);
  await source.setViewportSize({ width: 390, height: 300 });
  await source.waitForTimeout(60);
  moved = await bounds();
  assert.ok(moved.x >= 16 && moved.x + moved.width <= 374);
  assert.ok(moved.y >= 16 && moved.y + moved.height <= 284);
  await render({
    ...moving,
    jobId: "moving-next",
    results: Array(20).fill(results[2]),
  });
  await shadow((root) => {
    root.querySelector(".box").scrollTop = 10000;
  });
  const resultScroll = await shadow(
    (root) => root.querySelector(".box").scrollTop,
  );
  await toggleResults();
  await render({
    ...moving,
    jobId: "moving-next",
    results: Array(20).fill(results[2]),
  });
  await toggleResults();
  assert.equal(
    await shadow((root) => root.querySelector(".box").scrollTop),
    resultScroll,
  );
  const sticky = await grip();
  moved = await bounds();
  assert.ok(sticky.y >= moved.y && sticky.y < moved.y + 80);
  ok(
    "dragging stays inside the viewport, supports arrow keys, survives the next job and keeps the handle accessible after scrolling or resizing",
  );

  await source.mouse.move(sticky.x, sticky.y);
  await source.mouse.down();
  await source.keyboard.press("Escape");
  await source.mouse.up();
  assert.equal(await source.locator("[data-jev-overlay]").count(), 0);
  await render({ ...moving, jobId: "after-drag-close" });
  assert.equal(
    await shadow((root) => root.querySelector("#jev-result-body").hidden),
    false,
  );
  const beforeMove = await bounds();
  await source.mouse.move(300, 250);
  assert.deepEqual(await bounds(), beforeMove);
  await shadow((root) => root.querySelector(".close").click());
  assert.equal(await source.locator("[data-jev-overlay]").count(), 0);
  ok(
    "closing during a drag releases capture and listeners; a later overlay and its close button work normally",
  );

  await source.setViewportSize({ width: 1280, height: 720 });
  const resizing = { ...moving, jobId: "resize-test", phase: "complete" };
  await render(resizing);
  const resizeGrip = (edge) =>
    shadow((root, edge) => {
      const rect = root
        .querySelector(`[data-resize-edge="${edge}"]`)
        .getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, edge);
  const dragResize = async (edge, dx, dy) => {
    const point = await resizeGrip(edge);
    await source.mouse.move(point.x, point.y);
    await source.mouse.down();
    await source.mouse.move(point.x + dx, point.y + dy, { steps: 4 });
    await source.mouse.up();
  };
  const initialSize = await bounds();
  const resizeStart = await resizeGrip("se");
  await source.mouse.move(resizeStart.x, resizeStart.y);
  await source.mouse.down();
  await source.mouse.move(resizeStart.x + 60, resizeStart.y + 40, { steps: 3 });
  await render({ ...resizing, message: "サイズ変更中に更新" });
  await source.mouse.move(resizeStart.x + 120, resizeStart.y + 80, {
    steps: 3,
  });
  await source.mouse.up();
  const customSize = await bounds();
  assert.ok(Math.abs(customSize.width - initialSize.width - 120) < 1);
  assert.ok(Math.abs(customSize.height - initialSize.height - 80) < 1);
  assert.equal(customSize.x, initialSize.x);
  assert.equal(customSize.y, initialSize.y);
  assert.equal(
    await source.locator("[data-jev-overlay]").getAttribute("data-resizing"),
    null,
  );
  await toggleResults();
  assert.equal((await bounds()).width, customSize.width);
  assert.ok((await bounds()).height < customSize.height);
  await render({ ...resizing, results: Array(12).fill(results[2]) });
  await toggleResults();
  assert.equal((await bounds()).width, customSize.width);
  assert.equal((await bounds()).height, customSize.height);
  assert.equal(
    await shadow((root) => {
      const box = root.querySelector(".box");
      return box.scrollHeight > box.clientHeight;
    }),
    true,
  );
  await render({
    ...resizing,
    jobId: "resize-next",
    results: Array(12).fill(results[2]),
  });
  assert.equal((await bounds()).width, customSize.width);
  assert.equal((await bounds()).height, customSize.height);
  ok(
    "width and height resizing continues across live updates; custom size survives collapse, expansion and the next job with scrollable results",
  );

  await dragResize("nw", 40, 20);
  const northwestSize = await bounds();
  assert.equal(northwestSize.x, customSize.x + 40);
  assert.equal(northwestSize.y, customSize.y + 20);
  assert.equal(northwestSize.width, customSize.width - 40);
  assert.equal(northwestSize.height, customSize.height - 20);
  const southeast = await resizeGrip("se");
  await source.mouse.click(southeast.x, southeast.y);
  await source.keyboard.press("ArrowRight");
  await source.keyboard.press("Shift+ArrowDown");
  const keyboardSize = await bounds();
  assert.equal(keyboardSize.width, northwestSize.width + 20);
  assert.equal(keyboardSize.height, northwestSize.height + 60);
  await source.setViewportSize({ width: 390, height: 300 });
  await source.waitForTimeout(60);
  const small = await bounds();
  assert.ok(small.x >= 16 && small.x + small.width <= 374);
  assert.ok(small.y >= 16 && small.y + small.height <= 284);
  const closePoint = await shadow((root) => {
    const rect = root.querySelector(".close").getBoundingClientRect();
    return { bottom: rect.bottom, right: rect.right };
  });
  assert.ok(closePoint.bottom <= 284 && closePoint.right <= 374);
  await source.setViewportSize({ width: 1280, height: 720 });
  await source.waitForTimeout(60);
  assert.equal((await bounds()).width, keyboardSize.width);
  assert.equal((await bounds()).height, keyboardSize.height);
  await source.screenshot({
    path: ".test-artifacts/result-overlay-resized.png",
  });
  ok(
    "top and left resizing anchors the opposite edges; keyboard resizing and viewport changes keep controls accessible and restore the preferred size",
  );

  await dragResize("se", -2000, -2000);
  assert.equal((await bounds()).width, 280);
  assert.equal((await bounds()).height, 160);
  await dragResize("se", 4000, 4000);
  const maximum = await bounds();
  assert.ok(maximum.x + maximum.width <= 1264);
  assert.ok(maximum.y + maximum.height <= 704);
  const resetGrip = await resizeGrip("se");
  await source.mouse.dblclick(resetGrip.x, resetGrip.y);
  assert.equal((await bounds()).width, 380);
  await dragResize("e", 100, 0);
  await source.keyboard.press("Home");
  assert.equal((await bounds()).width, 380);
  ok(
    "minimum size and viewport bounds prevent unusable panels; double-click and Home restore the automatic default size",
  );

  const cancelResize = await resizeGrip("se");
  await source.mouse.move(cancelResize.x, cancelResize.y);
  await source.mouse.down();
  await source.keyboard.press("Escape");
  await source.mouse.up();
  assert.equal(await source.locator("[data-jev-overlay]").count(), 0);
  await render({ ...resizing, jobId: "resize-after-close" });
  const afterResizeClose = await bounds();
  await source.mouse.move(800, 500);
  assert.deepEqual(await bounds(), afterResizeClose);
  await shadow((root) => root.querySelector(".close").click());
  ok(
    "closing during resize releases pointer capture and listeners without affecting a later result panel",
  );
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  throw error;
} finally {
  await writeFile(
    "docs/result-targets-test-results.json",
    JSON.stringify(report, null, 2),
  );
  await context.close();
}
