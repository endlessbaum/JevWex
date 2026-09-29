import test from "node:test";
import assert from "node:assert/strict";
import { pageInputs } from "../../src/extension/page-judge";
import type { PageCapture } from "../../src/extension/capture";
import { validateScope } from "../../src/extension/content-scope";

const capture: PageCapture = {
  tabId: 1,
  url: "https://example.com",
  title: "List",
  text: "ALL CONTENT",
  selection: "incidental selection",
  truncated: true,
  selectionTruncated: false,
  capturedAt: "now",
  items: [
    {
      index: 1,
      label: "first",
      selector: "#one",
      text: "first content",
      truncated: false,
    },
    {
      index: 2,
      label: "second",
      selector: "#two",
      text: "second content",
      truncated: true,
    },
  ],
};
test("saved repeated items become isolated requests even when incidental selection exists", () => {
  assert.deepEqual(
    pageInputs(capture, "auto").map((input) => input.text),
    ["first content", "second content"],
  );
  assert.deepEqual(
    pageInputs(capture, "text").map((input) => input.item?.index),
    [1, 2],
  );
  assert.equal(pageInputs(capture, "text")[1].truncated, true);
  assert.deepEqual(
    pageInputs(capture, "selection").map((input) => input.text),
    ["incidental selection"],
  );
  assert.equal(
    pageInputs({ ...capture, items: undefined }, "auto")[0].text,
    "incidental selection",
  );
});
test("repeated selectors require an explicit container and preserve older single-scope settings", () => {
  assert.deepEqual(
    validateScope({ root: "#list", exclude: [], items: ":scope > li" }),
    { root: "#list", exclude: [], items: ":scope > li" },
  );
  assert.deepEqual(validateScope({ root: null, exclude: [] }), {
    root: null,
    exclude: [],
  });
  for (const items of ["", 42, "a".repeat(4001)])
    assert.throws(() => validateScope({ root: "#list", exclude: [], items }));
  assert.throws(() => validateScope({ root: null, exclude: [], items: "li" }));
});

test("result targets retain actual item or combined-root identity independently of inference text", () => {
  const root = { selector: "#list", token: "root" };
  const first = { selector: "#one", token: "one" };
  const source = {
    ...capture,
    target: root,
    items: [{ ...capture.items![0], target: first }],
  };
  const item = pageInputs(source, "text")[0];
  assert.deepEqual(item.target, first);
  assert.equal("target" in item.item!, false);
  assert.deepEqual(
    pageInputs({ ...source, items: undefined }, "text")[0].target,
    root,
  );
  assert.equal(pageInputs(source, "selection")[0].target, undefined);
});
