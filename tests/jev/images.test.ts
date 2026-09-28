import { gguf, response } from "../fixtures/readout";
import test from "node:test";
import assert from "node:assert/strict";
import type {
  ChatCompletionParams,
  ChatCompletionResponse,
  Model,
  ModelManager,
  ModelSource,
} from "@wllama/wllama";
import { ModelSession, type Runtime } from "../../src/inference/model-session";
import { ModelDownload } from "../../src/inference/model-download";
import {
  validateImageFiles,
  MAX_IMAGE_BYTES,
  type InputImage,
} from "../../src/features/jev/images";
const picture: InputImage = {
  name: "red.png",
  type: "image/png",
  size: 3,
  width: 1,
  height: 1,
  data: new Uint8Array([1, 2, 3]).buffer,
};
test("image input restricts type, count and size", () => {
  validateImageFiles([picture]);
  for (const file of [
    { ...picture, type: "image/svg+xml" },
    { ...picture, size: 0 },
    { ...picture, size: MAX_IMAGE_BYTES + 1 },
  ])
    assert.throws(() => validateImageFiles([file]));
  assert.throws(() => validateImageFiles([picture], 4));
});
function session(
  imagesSupported: boolean,
  handler: (p: ChatCompletionParams) => Promise<ChatCompletionResponse>,
) {
  const instance = new ModelSession(
    () =>
      ({
        loadModel: async () => {},
        exit: async () => {},
        getChatTemplate: () => "template",
        getNumThreads: () => 1,
        getLoadedContextInfo: () => ({
          n_ctx: 4096,
          has_image_input: imagesSupported,
        }),
        createChatCompletion: handler,
      }) as Runtime,
  );
  instance.register({
    id: "image-model",
    label: "image-model",
    size: 10,
    source: [gguf()],
  });
  return instance;
}
const input = {
  state: "attached image",
  questions: {
    a: { type: "noul" as const, instructions: "Is it red?" },
    b: { type: "noul" as const, instructions: "Is it blue?" },
  },
};
test("text-only runtime rejects images before making inference calls", async () => {
  const s = session(false, async () =>
    assert.fail("must not silently ignore images"),
  );
  await s.load();
  await assert.rejects(
    s.evaluate(input, undefined, [picture]),
    /画像を読み取れません/,
  );
  assert.equal(s.phase, "ready");
});
test("each criterion gets immutable image bytes via public multimodal content and exports metadata only", async () => {
  const received: number[][] = [];
  const s = session(true, async (p) => {
    const user = p.messages.find((m) => m.role === "user")!;
    assert.ok(Array.isArray(user.content));
    const image = user.content.find((part) => part.type === "image")!;
    assert.equal(image.type, "image");
    received.push(Array.from(new Uint8Array(image.data)));
    // Public worker APIs may transfer the supplied buffer: later criteria still need intact bytes.
    structuredClone(image.data, { transfer: [image.data] });
    return response([0.7, 0.3]);
  });
  await s.load();
  const images = [structuredClone(picture)];
  const run = s.evaluate(input, undefined, images);
  new Uint8Array(images[0].data).fill(0);
  images[0].name = "changed.png";
  const out = await run;
  assert.deepEqual(received, [
    [1, 2, 3],
    [1, 2, 3],
  ]);
  assert.equal(out.diagnostics.images![0].name, "red.png");
  assert.equal("data" in out.diagnostics.images![0], false);
});
const url =
  "https://huggingface.co/owner/vision/resolve/main/model-Q4_K_M.gguf";
const mmprojUrl =
  "https://huggingface.co/owner/vision/resolve/main/mmproj-F16.gguf";
test("repository vision download passes paired ModelSource to public manager", async () => {
  const download = new ModelDownload(
    {
      getModels: async () => [],
      downloadModel: async (source: string | ModelSource) => {
        assert.deepEqual(source, { url, mmprojUrl });
        return { url, mmprojUrl, size: 123, validate: () => "valid" } as Model;
      },
      cacheManager: { delete: async () => {} },
    } as unknown as ModelManager,
    async () => ({ url, mmprojUrl }),
  );
  const result = await download.download(
    "owner/vision",
    () => {},
    (main, projector) => assert.deepEqual([main, projector], [url, mmprojUrl]),
  );
  assert.equal(result.mmprojUrl, mmprojUrl);
});
test("failed paired transfer cleans both new files but preserves an existing model", async () => {
  for (const cached of [false, true]) {
    const removed: string[] = [];
    const download = new ModelDownload({
      getModels: async () => (cached ? [{ url, size: 123 }] : []),
      downloadModel: async () => {
        throw new Error("projector failure");
      },
      cacheManager: {
        delete: async (target: string) => {
          removed.push(target);
        },
      },
    } as unknown as ModelManager);
    await assert.rejects(
      download.download(
        url,
        () => {},
        () => {},
        mmprojUrl,
      ),
      /projector failure/,
    );
    assert.deepEqual(removed, cached ? [mmprojUrl] : [url, mmprojUrl]);
  }
});
test("paired model cache is reused offline and projector URLs use the same allowlist", async () => {
  const model = { url, mmprojUrl, size: 123 } as Model;
  const download = new ModelDownload(
    {
      getModels: async () => [model],
      downloadModel: async () => assert.fail("offline cache"),
    } as unknown as ModelManager,
    async () => assert.fail("offline lookup"),
  );
  assert.equal(await download.download("owner/vision", () => {}), model);
  await assert.rejects(
    download.download(
      url,
      () => {},
      () => {},
      "https://example.com/mmproj.gguf",
    ),
  );
});
