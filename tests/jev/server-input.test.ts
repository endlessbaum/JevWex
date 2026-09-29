import test from "node:test";
import assert from "node:assert/strict";
import { decodeApiInput } from "../../src/server/input";
const input = {
  state: "A cat.",
  questions: { cat: { type: "noul", instructions: "Mentions a cat." } },
};
test("server input reuses existing validator", async () => {
  assert.deepEqual(await decodeApiInput(input), { request: input, images: [] });
  await assert.rejects(decodeApiInput({ ...input, questions: {} }));
  await assert.rejects(decodeApiInput({ ...input, unexpected: true }));
});
test("image transport rejects malformed base64, unsupported formats and too many images", async () => {
  for (const images of [
    "bad",
    [{}],
    Array(5).fill({}),
    [
      {
        name: "x.png",
        mime_type: "image/png",
        data_base64: "https://example.com",
      },
    ],
    [{ name: "x.gif", mime_type: "image/gif", data_base64: "AAAA" }],
  ])
    await assert.rejects(decodeApiInput({ ...input, images }));
});
