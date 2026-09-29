import test from "node:test";
import assert from "node:assert/strict";
import {
  captureTab,
  CapturePermissionError,
  pagePermissionOrigin,
} from "../../src/extension/capture";

test("page access requests are limited to the exact HTTP(S) host, never all sites or restricted pages", () => {
  assert.equal(
    pagePermissionOrigin("https://Example.org:8443/article?q=1#heading"),
    "https://example.org/*",
  );
  assert.equal(
    pagePermissionOrigin("http://localhost:3000/page"),
    "http://localhost/*",
  );
  assert.equal(
    pagePermissionOrigin("https://news.example.org/"),
    "https://news.example.org/*",
  );
  for (const value of [
    undefined,
    "bad URL",
    "file:///tmp/page.html",
    "chrome://settings",
    "chrome-extension://test/index.html",
    "https://chromewebstore.google.com/detail/test",
    "https://chrome.google.com/webstore/detail/test",
  ])
    assert.equal(pagePermissionOrigin(value), undefined);
});

test("capture distinguishes permission failures, restricted pages, closed tabs and transient failures", async () => {
  for (const [detail, expected] of [
    [
      "Cannot access contents of url https://example.org/. Extension manifest must request permission to access this host.",
      /読み取り権限.*拡張アイコン/,
    ],
    ["Cannot access a chrome:// URL", /取得対象外/],
    ["No tab with id: 42.", /タブが閉じられ/],
    ["Frame with ID 0 was removed.", /読み込み完了後.*Frame/],
  ] as const) {
    Object.assign(globalThis, {
      chrome: {
        tabs: { get: async () => ({ url: "https://example.org/article" }) },
        storage: { local: { get: async () => ({}) } },
        scripting: {
          executeScript: async () => {
            throw new Error(detail);
          },
        },
      },
    });
    await assert.rejects(captureTab(42), expected);
    if (detail.includes("manifest"))
      await assert.rejects(captureTab(42), CapturePermissionError);
  }
});

test("capture retains the document identity and refuses unsupported URLs", async () => {
  let url = "https://example.org/article";
  Object.assign(globalThis, {
    chrome: {
      tabs: { get: async () => ({ url }) },
      storage: { local: { get: async () => ({}) } },
      scripting: {
        executeScript: async () => [
          {
            documentId: "document-1",
            result: {
              url,
              text: "Article",
              selection: "",
              title: "Test",
              truncated: false,
              selectionTruncated: false,
              capturedAt: "now",
            },
          },
        ],
      },
    },
  });
  const capture = await captureTab(42);
  assert.equal(capture.tabId, 42);
  assert.equal(capture.documentId, "document-1");
  assert.equal(capture.text, "Article");
  url = "chrome-extension://test/index.html";
  await assert.rejects(captureTab(42), /取得対象外/);
});
