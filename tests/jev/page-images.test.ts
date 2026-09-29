import test from "node:test";
import assert from "node:assert/strict";
import { imageOrigins, loadPageImages } from "../../src/extension/page-images";
import { validateScope } from "../../src/extension/content-scope";
import { pageInputs } from "../../src/extension/page-judge";
import type { PageCapture } from "../../src/extension/capture";

test("image settings persist with targets, while image data is not saved", () => {
  assert.deepEqual(
    validateScope({ root: "img", exclude: [], images: true, bytes: "discard" }),
    { root: "img", exclude: [], images: true },
  );
  assert.throws(() =>
    validateScope({ root: null, exclude: [], images: "true" }),
  );
  assert.deepEqual(validateScope({ root: null, exclude: [] }), {
    root: null,
    exclude: [],
  });
});

test("image permissions use exact HTTP(S) hosts and discard credentials and executable schemes", () => {
  assert.deepEqual(
    imageOrigins(
      [
        "https://i.ytimg.com/vi/a/hq.webp",
        "https://i.ytimg.com/vi/b/hq.jpg",
        "https://evil.test@private.test/a",
        "javascript:alert(1)",
        "file:///secret.png",
        "data:image/png;base64,AA==",
        "not a URL",
      ].map((url) => ({ url, label: "" })),
    ),
    ["https://i.ytimg.com/*"],
  );
});

test("independent item inputs retain only their own images; selection carries none", () => {
  const images = [{ url: "https://example.org/one.png", label: "one" }];
  const capture = {
    text: "page",
    selection: "selected",
    images,
    items: [
      {
        index: 1,
        label: "one",
        selector: "#one",
        text: "",
        images,
        truncated: false,
      },
      {
        index: 2,
        label: "two",
        selector: "#two",
        text: "two",
        truncated: false,
      },
    ],
  } as PageCapture;
  const inputs = pageInputs(capture, "text");
  assert.deepEqual(inputs[0].images, images);
  assert.equal(inputs[1].images, undefined);
  assert.equal("images" in inputs[0].item!, false);
  assert.equal(pageInputs(capture, "selection")[0].images, undefined);
});

test("unpermitted images, unsupported URLs, excessive image count and cancellation fail before fetching", async () => {
  Object.assign(globalThis, {
    chrome: { permissions: { contains: async () => false } },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("must not fetch");
  };
  try {
    const signal = new AbortController().signal;
    await assert.rejects(
      loadPageImages([{ url: "https://i.ytimg.com/a.jpg", label: "" }], signal),
      /未許可/,
    );
    for (const url of [
      "file:///a",
      "blob:https://example.org/a",
      "data:image/svg+xml,a",
      "https://u:p@example.org/a",
    ])
      await assert.rejects(
        loadPageImages([{ url, label: "" }], signal),
        /URLは取得できません/,
      );
    await assert.rejects(
      loadPageImages(
        Array(5).fill({ url: "https://example.org/a", label: "" }),
        signal,
      ),
      /4枚/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      loadPageImages(
        [{ url: "https://example.org/a", label: "" }],
        controller.signal,
      ),
      /abort/i,
    );
  } finally {
    globalThis.fetch = original;
  }
});
