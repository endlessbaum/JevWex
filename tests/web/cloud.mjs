import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import {
  fillSingleCriterion,
  navigate,
  loadModel,
  runEvaluation,
} from "../extension/ui-helpers.mjs";

const root = resolve("dist-web");
let mode = "success",
  calls = 0;
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (req.url === "/cloud") {
    calls++;
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    assert.equal(body.model, "jev-latest");
    assert.equal(req.headers.authorization, "Bearer test-only-key");
    if (mode === "wait") return;
    res.writeHead(mode === "error" ? 503 : 200, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify({
        model: "jev-test",
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [
            id,
            { type: "noul", noul: 0.88 },
          ]),
        ),
      }),
    );
    return;
  }
  try {
    const path = resolve(
      root,
      "." +
        (new URL(req.url, "http://localhost").pathname === "/"
          ? "/index.html"
          : new URL(req.url, "http://localhost").pathname),
    );
    if (!path.startsWith(root + "/") && !path.startsWith(root + "\\"))
      throw new Error("Invalid path");
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".wasm": "application/wasm",
        }[extname(path)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const extension = process.argv.includes("--extension");
const persistent = extension
  ? await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--enable-unsafe-extension-debugging"],
    })
  : undefined;
const browser =
  persistent?.browser() ?? (await chromium.launch({ headless: true }));
const context = persistent ?? (await browser.newContext());
try {
  let appUrl = base;
  if (extension) {
    const cdp = await browser.newBrowserCDPSession();
    const { id } = await cdp.send("Extensions.loadUnpacked", {
      path: resolve("dist"),
    });
    appUrl = `chrome-extension://${id}/index.html`;
    // Pre-approve this disposable profile's test host, then exercise the real
    // permissions.request from the button (native dialogs are not automated).
    const settings = await context.newPage();
    await settings.goto("chrome://extensions/");
    await settings.evaluate(
      (id) =>
        chrome.developerPrivate.addHostPermission(id, "http://127.0.0.1/*"),
      id,
    );
    await settings.close();
  }
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(appUrl);
  await navigate(page, "models");
  assert.match(await page.locator("#cloud-active").innerText(), /ローカル/);
  assert.equal(calls, 0);
  assert.equal(
    await page.locator("#external-transmission-warning").isVisible(),
    false,
  );
  assert.equal(
    await page.locator("#cloud-new, #cloud-apply, #cloud-local").count(),
    0,
  );
  assert.equal(
    await page.locator("#cloud-key-save").innerText(),
    "設定を保存して使用する",
  );
  assert.equal(
    await page.evaluate(
      () =>
        !!(
          document
            .querySelector("#cloud-fallback")
            .compareDocumentPosition(
              document.querySelector("#cloud-key-save"),
            ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
    true,
  );
  await page.locator("#cloud-endpoint").fill(base + "/cloud");
  await page.locator("#cloud-key").fill("test-only-key");
  await page.locator("#cloud-key-save").click();
  await page.locator("#error").waitFor({ state: "visible" });
  assert.match(await page.locator("#error").innerText(), /ローカルモデル/);
  await page.locator("#cloud-fallback").uncheck();
  await page.locator("#cloud-key-save").click();
  await page.waitForFunction(() =>
    document.querySelector("#cloud-active").textContent.includes("JEV互換API"),
  );
  assert.equal(await page.locator("#models [data-cloud-id]").count(), 1);
  assert.equal(
    await page.locator("#models [data-cloud-id]").getAttribute("data-active"),
    "true",
  );
  assert.equal(await page.locator("#cloud-name").inputValue(), "");
  assert.equal(
    await page.locator("#external-transmission-warning").isVisible(),
    true,
  );
  assert.match(
    await page.locator("#external-transmission-warning").innerText(),
    /外部サイトへ情報を送信します/,
  );
  assert.equal(
    await page.locator("#external-transmission-destination").innerText(),
    base,
  );
  await mkdir(".test-artifacts", { recursive: true });
  await page
    .locator("#external-transmission-warning")
    .screenshot({
      path: `.test-artifacts/cloud-transmission-warning${extension ? "-extension" : ""}.png`,
    });
  await fillSingleCriterion(page);
  if (extension) {
    assert.equal(
      await page.evaluate(
        (origin) => chrome.permissions.contains({ origins: [origin + "/*"] }),
        base,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(() =>
        chrome.permissions.contains({
          origins: ["https://unrelated.example/*"],
        }),
      ),
      false,
    );
  }
  const remote = await runEvaluation(page);
  assert.equal(remote.response.model, "jev-test");
  assert.equal(remote.diagnostics.provider, "jev");
  assert.doesNotMatch(JSON.stringify(remote), /test-only-key/);
  assert.doesNotMatch(
    await page.evaluate(() => JSON.stringify(localStorage)),
    /test-only-key/,
  );
  await navigate(page, "models");
  await page.locator('[data-cloud-action="edit"]').click();
  // Timeout changes reuse the current credentials without putting them in localStorage.
  await page.locator("#cloud-timeout").fill("45");
  await page.locator("#cloud-key-save").click();
  await navigate(page, "judge");
  assert.equal((await runEvaluation(page)).response.model, "jev-test");
  await navigate(page, "models");
  await page
    .locator("#files")
    .setInputFiles(resolve(".models/SmolLM2-135M-Instruct.Q4_K_M.gguf"));
  await page.waitForFunction(
    () => !document.querySelector('[data-model-action="load"]').disabled,
  );
  await loadModel(page);
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "準備完了",
    null,
    { timeout: 180000 },
  );
  assert.match(await page.locator("#cloud-active").innerText(), /ローカル/);
  assert.equal(
    await page.locator("#external-transmission-warning").isVisible(),
    false,
  );
  assert.equal(await page.locator("#cloud-key").inputValue(), "");
  await page.locator('[data-cloud-action="edit"]').click();
  await page.locator("#cloud-fallback").check();
  await page.locator("#cloud-key-save").click();
  await page.waitForFunction(() =>
    document.querySelector("#cloud-active").textContent.includes("JEV互換API"),
  );
  // Returning to an already loaded local model from the shared list keeps it
  // available; the saved API can then be selected again without editing/key entry.
  await page.locator('[data-model-action="load"]').click();
  await page.waitForFunction(() =>
    document.querySelector("#cloud-active").textContent.includes("ローカル"),
  );
  await page.locator('[data-cloud-action="select"]').click();
  await page.waitForFunction(() =>
    document.querySelector("#cloud-active").textContent.includes("JEV互換API"),
  );
  mode = "error";
  await navigate(page, "judge");
  const fallback = await runEvaluation(page);
  assert.match(fallback.response.model, /^local:/);
  assert.equal(fallback.diagnostics.fallback.from, "jev");
  assert.match(
    await page.locator("#result-note").innerText(),
    /フォールバック/,
  );
  mode = "wait";
  await page.locator("#run").click();
  await page.waitForFunction(() => !document.querySelector("#cancel").disabled);
  await page.locator("#cancel").click();
  await page.waitForFunction(() => !document.querySelector("#run").disabled);
  await navigate(page, "models");
  await mkdir(".test-artifacts", { recursive: true });
  await page
    .locator('[aria-labelledby="cloud-heading"]')
    .screenshot({ path: ".test-artifacts/cloud-settings.png" });
  const previousCalls = calls;
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector("#cloud-active").textContent.includes("ローカル"),
  );
  assert.equal(await page.locator("#cloud-key").inputValue(), "");
  assert.equal(
    await page.locator("#cloud-endpoint").inputValue(),
    base + "/cloud",
  );
  assert.equal(calls, previousCalls);
  assert.deepEqual(errors, []);
  console.log(
    "PASS cloud selection, no secrets in localStorage or results, real WASM local fallback, cancellation, local reload defaults",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
