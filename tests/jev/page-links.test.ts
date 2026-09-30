import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchLinkHtml,
  linkInput,
  linkOrigin,
  linkOrigins,
  LINK_LIMITS,
  linkCharacterLimit,
} from "../../src/extension/page-links";
import {
  validateScope,
  describeScope,
} from "../../src/extension/content-scope";
import { pageInputs } from "../../src/extension/page-judge";
import type { PageCapture } from "../../src/extension/capture";

test("linked-page scopes persist only the switch, and preserve ordinary targets", () => {
  const scope = { root: "#article-link", exclude: [], linkedPages: true };
  assert.deepEqual(
    validateScope({ ...scope, fetchedText: "not stored" }),
    scope,
  );
  assert.match(describeScope(scope), /リンク先/);
  assert.deepEqual(validateScope({ root: null, exclude: [] }), {
    root: null,
    exclude: [],
  });
  assert.throws(() => validateScope({ ...scope, linkedPages: "true" }));
  assert.throws(() => validateScope({ ...scope, images: true }));
});
test("only bounded HTTP(S) URLs with no URL credentials can be fetched", () => {
  assert.equal(
    linkOrigin("https://example.com:8443/a?q=x#here"),
    "https://example.com/*",
  );
  for (const url of [
    "javascript:alert(1)",
    "mailto:test@example.com",
    "file:///secret",
    "https://u:p@example.com",
    "invalid",
    "https://example.com/" + "x".repeat(4000),
  ])
    assert.equal(linkOrigin(url), undefined);
  assert.deepEqual(
    linkOrigins([
      { url: "https://example.com/a", label: "a" },
      { url: "https://example.com/b", label: "b" },
      { url: "mailto:x", label: "x" },
    ]),
    ["https://example.com/*"],
  );
});
test("permissions are checked before requests and requests omit credentials and referrers", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://example.com/article");
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.redirect, "error");
    return new Response("<main>Astronomy</main>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  const signal = new AbortController().signal;
  await assert.rejects(
    fetchLinkHtml(
      "https://example.com/article",
      signal,
      fetcher,
      async () => false,
    ),
    /未許可/,
  );
  assert.equal(calls, 0);
  assert.match(
    await fetchLinkHtml(
      "https://example.com/article",
      signal,
      fetcher,
      async () => true,
    ),
    /Astronomy/,
  );
  assert.equal(calls, 1);
});
test("HTTP errors, non-HTML and oversized streams fail explicitly", async () => {
  const signal = new AbortController().signal,
    allowed = async () => true;
  for (const [body, status, type, expected] of [
    ["denied", 403, "text/html", /403/],
    ["pdf", 200, "application/pdf", /HTML/],
    ["x".repeat(LINK_LIMITS.bytes + 1), 200, "text/html", /1 MiB/],
  ] as const)
    await assert.rejects(
      fetchLinkHtml(
        "https://example.com/a",
        signal,
        async () =>
          new Response(body, { status, headers: { "content-type": type } }),
        allowed,
      ),
      expected,
    );
});
test("non-UTF8 pages honor declared encodings; abort prevents fetch and interrupts in-flight fetch", async () => {
  const html = await fetchLinkHtml(
    "https://example.com/a",
    new AbortController().signal,
    async () =>
      new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
        headers: { "content-type": "text/html; charset=windows-1252" },
      }),
    async () => true,
  );
  assert.equal(html, "café");
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    fetchLinkHtml(
      "https://example.com/a",
      controller.signal,
      async () => {
        calls++;
        return new Response();
      },
      async () => true,
    ),
  );
  assert.equal(calls, 0);
  const active = new AbortController();
  const pending = fetchLinkHtml(
    "https://example.com/a",
    active.signal,
    async (_, init) =>
      new Promise((_, reject) =>
        init!.signal!.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        ),
      ),
    async () => true,
  );
  const rejection = assert.rejects(pending);
  await new Promise((resolve) => setTimeout(resolve, 0));
  active.abort();
  await rejection;
});
test("link inputs are separate from source-page text and preserve each original target", () => {
  const source: PageCapture = {
    tabId: 1,
    url: "https://example.com/source",
    title: "Source",
    text: "source text",
    selection: "selection",
    truncated: false,
    selectionTruncated: false,
    capturedAt: "now",
    items: [
      {
        target: { selector: "#a", token: "a" },
        index: 1,
        selector: "#a",
        label: "A",
        text: "source label",
        truncated: false,
        links: [{ url: "https://example.com/a", label: "A" }],
      },
    ],
  };
  const input = pageInputs(source, "text")[0];
  assert.equal(input.links?.[0].url, "https://example.com/a");
  assert.deepEqual(input.target, { selector: "#a", token: "a" });
  assert.equal("links" in input.item!, false);
  assert.equal("links" in pageInputs(source, "selection")[0], false);
  assert.match(
    linkInput(
      [
        {
          url: "https://example.com/a",
          label: "A",
          title: "Universe",
          text: "Astronomy",
          truncated: true,
        },
      ],
      1000,
    ),
    /本文（上限のため一部を省略）[\s\S]*Astronomy/,
  );
});
test("link input budgets track the loaded context and share its 80% across all destination bodies", () => {
  assert.equal(linkCharacterLimit(1024), 819);
  assert.equal(linkCharacterLimit(4096), 3276);
  assert.equal(linkCharacterLimit(8192), 6553);
  assert.equal(linkCharacterLimit(), 819);
  const excerpts = ["A", "B", "C", "D"].map((label) => ({
    url: "https://example.com/" + label,
    label,
    title: "HEAD TITLE",
    text: label.repeat(9000),
    truncated: false,
  }));
  for (const context of [1024, 4096, 8192]) {
    const limit = linkCharacterLimit(context);
    const input = linkInput(excerpts, limit);
    assert.ok(input.length <= limit);
    for (const label of ["A", "B", "C", "D"])
      assert.ok(input.includes(label.repeat(10)));
    assert.doesNotMatch(input, /HEAD TITLE|https:\/\/|リンク名/);
  }
});
