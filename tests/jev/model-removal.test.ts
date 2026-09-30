import test from "node:test";
import assert from "node:assert/strict";
import type { CacheEntry } from "@wllama/wllama";
import { removeCachedModel } from "../../src/inference/model-removal";
const entry = (url: string, mmprojURL?: string): CacheEntry => ({
  name: url,
  size: 32,
  metadata: { originalURL: url, originalSize: 32, etag: "", mmprojURL },
});
function cacheFixture(initial: CacheEntry[]) {
  let files = initial;
  return {
    list: async () => files,
    deleteMany: async (predicate: (file: CacheEntry) => boolean) => {
      files = files.filter((file) => !predicate(file));
    },
  };
}
test("deleting a split model removes all its shards but preserves another model's shared projector", async () => {
  const a = "https://example.com/a-00001-of-00002.gguf",
    a2 = a.replace("00001", "00002"),
    b = "https://example.com/b.gguf",
    p = "https://example.com/mmproj.gguf";
  const cache = cacheFixture([
    entry(a, p),
    entry(a2, p),
    entry(b, p),
    entry(p, p),
  ]);
  assert.equal(
    (await removeCachedModel(cache, { url: a, mmprojUrl: p })).sharedProjector,
    true,
  );
  assert.deepEqual(
    (await cache.list()).map((file) => file.name),
    [b, p],
  );
  assert.equal(
    (await removeCachedModel(cache, { url: b, mmprojUrl: p })).sharedProjector,
    false,
  );
  assert.deepEqual(await cache.list(), []);
});
test("a projector referenced by another model cannot be removed on its own", async () => {
  const cache = cacheFixture([entry("a.gguf", "p.gguf"), entry("p.gguf")]);
  await assert.rejects(
    removeCachedModel(cache, { url: "p.gguf" }),
    /別のモデルの画像用ファイル/,
  );
  assert.equal((await cache.list()).length, 2);
});
test("unrelated files survive removal; cache failures remain errors", async () => {
  const cache = cacheFixture([entry("a.gguf"), entry("other.gguf")]);
  await removeCachedModel(cache, { url: "a.gguf" });
  assert.deepEqual(
    (await cache.list()).map((file) => file.name),
    ["other.gguf"],
  );
  await assert.rejects(
    removeCachedModel(
      {
        ...cache,
        deleteMany: async () => {
          throw new Error("disk unavailable");
        },
      },
      { url: "other.gguf" },
    ),
    /disk unavailable/,
  );
});
