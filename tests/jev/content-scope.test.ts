import test from "node:test";
import assert from "node:assert/strict";
import {
  readScope,
  scopeKey,
  validateScope,
} from "../../src/extension/content-scope";

test("content scope is URL-specific, ignores anchors, retains query and persists only selectors", () => {
  assert.equal(
    scopeKey("https://example.com/page?q=1#part"),
    scopeKey("https://example.com/page?q=1"),
  );
  assert.notEqual(
    scopeKey("https://example.com/page?q=1"),
    scopeKey("https://example.com/page?q=2"),
  );
  assert.deepEqual(
    validateScope({
      root: "#article",
      exclude: ["#ad", "#ad"],
      text: "not stored",
    }),
    { root: "#article", exclude: ["#ad"] },
  );
  assert.throws(() => scopeKey("chrome://extensions"));
});
test("malformed or oversized selectors are rejected; missing settings use automatic content selection", async () => {
  for (const value of [
    null,
    {},
    { root: 5, exclude: [] },
    { root: "", exclude: [] },
    { root: "a".repeat(4001), exclude: [] },
    { root: null, exclude: [false] },
    { root: null, exclude: Array(65).fill("a") },
  ])
    assert.throws(() => validateScope(value));
  Object.assign(globalThis, {
    chrome: { storage: { local: { get: async () => ({}) } } },
  });
  assert.deepEqual(await readScope("https://example.com"), {
    root: null,
    exclude: [],
  });
});

test("shared child exclusions retain only bounded structural selectors, including automatic roots", () => {
  const rule = {
    container: "#list",
    items: ":scope > li",
    path: ":scope > article:nth-of-type(1) > a:nth-of-type(1)",
  };
  assert.deepEqual(
    validateScope({
      root: null,
      exclude: [],
      sharedExclude: [{ ...rule, text: "not stored" }],
    }),
    { root: null, exclude: [], sharedExclude: [rule] },
  );
  for (const sharedExclude of [
    {},
    [null],
    [{ ...rule, items: "" }],
    [{ ...rule, path: 123 }],
    [{ ...rule, container: "a".repeat(4001) }],
    Array(65).fill(rule),
  ])
    assert.throws(() =>
      validateScope({ root: null, exclude: [], sharedExclude }),
    );
  assert.throws(() =>
    validateScope({
      root: "#list",
      exclude: ["#one"],
      sharedExclude: Array(64).fill(rule),
    }),
  );
});
