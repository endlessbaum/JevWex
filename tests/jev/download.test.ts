import test from "node:test";
import assert from "node:assert/strict";
import type { ModelManager, Model, DownloadOptions } from "@wllama/wllama";
import {
  ModelDownload,
  modelDownloadUrl,
  EXAMPLE_MODEL_URL,
  modelDownloadInput,
} from "../../src/inference/model-download";
const model = {
  url: EXAMPLE_MODEL_URL,
  size: 123,
  validate: () => "valid",
} as Model;
function fixture() {
  const deleted: string[] = [];
  let cached: Model[] = [];
  let calls = 0;
  let fetchModel = async (_: string, opts: DownloadOptions): Promise<Model> => {
    opts.progressCallback?.({ loaded: 123, total: 123 });
    return model;
  };
  const manager = {
    getModels: async () => cached,
    downloadModel: (url: string, opts: DownloadOptions) => {
      calls++;
      return fetchModel(url, opts);
    },
    cacheManager: {
      delete: async (url: string) => {
        deleted.push(url);
      },
    },
  } as unknown as ModelManager;
  return {
    download: new ModelDownload(manager),
    deleted,
    calls: () => calls,
    cache: (m: Model[]) => {
      cached = m;
    },
    fetch: (f: typeof fetchModel) => {
      fetchModel = f;
    },
  };
}
const repo = "unsloth/Qwen3-0.6B-GGUF";
const repoUrl = `https://huggingface.co/${repo}/resolve/main/Qwen3-0.6B-Q4_K_M.gguf`;
test("short repo input trims copied spaces and HTML space entities", () => {
  for (const value of [repo, ` ${repo}\n`, `${repo}\u00a0`, `${repo} &#x20;`])
    assert.deepEqual(modelDownloadInput(value), { repo });
  assert.deepEqual(modelDownloadInput(EXAMPLE_MODEL_URL), {
    url: EXAMPLE_MODEL_URL,
  });
  for (const value of ["", "../name", "a/b/c", "owner/repo?token=x"])
    assert.throws(() => modelDownloadInput(value));
});
test("repo resolves with public API and explicit Q4_K_M before transfer", async () => {
  const events: string[] = [];
  const manager = {
    getModels: async () => [],
    downloadModel: async (url: string) => {
      events.push(url);
      return { ...model, url };
    },
    cacheManager: { delete: async () => {} },
  } as unknown as ModelManager;
  const download = new ModelDownload(manager, async (config) => {
    assert.deepEqual(config, { repo, quant: "Q4_K_M", mmprojQuant: "" });
    return { url: repoUrl };
  });
  await download.download(
    repo,
    () => {},
    (url) => events.push("resolved:" + url),
  );
  assert.deepEqual(events, ["resolved:" + repoUrl, repoUrl]);
});
test("a single cached Q4_K_M is reusable from repo input without network", async () => {
  const cached = { ...model, url: repoUrl };
  const manager = {
    getModels: async () => [cached],
    downloadModel: async () => assert.fail("unexpected transfer"),
    cacheManager: { delete: async () => assert.fail("unexpected delete") },
  } as unknown as ModelManager;
  const download = new ModelDownload(manager, async () =>
    assert.fail("unexpected lookup"),
  );
  assert.equal(await download.download(repo, () => {}), cached);
});
test("missing quant errors instead of falling back to a larger model", async () => {
  const manager = {
    getModels: async () => [],
    downloadModel: async () => assert.fail("unexpected transfer"),
    cacheManager: { delete: async () => assert.fail("unexpected delete") },
  } as unknown as ModelManager;
  const download = new ModelDownload(manager, async () => {
    throw new Error("No GGUF file found");
  });
  await assert.rejects(
    download.download(repo, () => {}),
    /Q4_K_M/,
  );
  assert.equal(download.busy, false);
});
test("cancellation during repo lookup prevents download and cache deletion", async () => {
  let finish!: (value: { url: string }) => void;
  const manager = {
    getModels: async () => [],
    downloadModel: async () => assert.fail("unexpected transfer"),
    cacheManager: { delete: async () => assert.fail("unexpected delete") },
  } as unknown as ModelManager;
  const download = new ModelDownload(
    manager,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = download.download(repo, () => {});
  await Promise.resolve();
  download.cancel();
  finish({ url: repoUrl });
  await assert.rejects(pending, /中止/);
});
test("download URL is explicit HTTPS Hugging Face resolve GGUF; optional download query canonicalized", () => {
  assert.equal(
    modelDownloadUrl(" " + EXAMPLE_MODEL_URL + "?download=true "),
    EXAMPLE_MODEL_URL,
  );
});
for (const url of [
  "http://huggingface.co/a/b/resolve/main/c.gguf",
  "https://evil.example/a.gguf",
  "https://huggingface.co.evil.example/a/b/resolve/main/c.gguf",
  "https://token@huggingface.co/a/b/resolve/main/c.gguf",
  "https://huggingface.co/a/b/blob/main/c.gguf",
  EXAMPLE_MODEL_URL + "?token=secret",
  EXAMPLE_MODEL_URL + "#x",
  "https://huggingface.co/a/b/resolve/main/a.js",
  "https://huggingface.co/a/b/resolve/main/a-00001-of-00002.gguf",
])
  test(`reject download URL ${url}`, () =>
    assert.throws(() => modelDownloadUrl(url)));
test("completed cache avoids every download and progress reports size", async () => {
  const f = fixture();
  f.cache([model]);
  let size = 0;
  await f.download.download(EXAMPLE_MODEL_URL, (p) => {
    size = p.total;
  });
  assert.equal(f.calls(), 0);
  assert.equal(size, 123);
});
test("download cancellation awaits acknowledgement, removes partial file, allows retry", async () => {
  const f = fixture();
  f.fetch(
    async (_, opts) =>
      new Promise((_, reject) =>
        opts.signal!.addEventListener("abort", () =>
          setTimeout(
            () => reject(new DOMException("cancelled", "AbortError")),
            5,
          ),
        ),
      ),
  );
  const run = f.download.download(EXAMPLE_MODEL_URL, () => {});
  await Promise.resolve();
  await assert.rejects(
    f.download.download(EXAMPLE_MODEL_URL, () => {}),
    /ダウンロード中/,
  );
  f.download.cancel();
  assert.ok(f.download.busy);
  await assert.rejects(run, /中止/);
  assert.equal(f.download.busy, false);
  assert.deepEqual(f.deleted, [EXAMPLE_MODEL_URL]);
  f.fetch(async () => model);
  assert.equal(await f.download.download(EXAMPLE_MODEL_URL, () => {}), model);
});
test("early cancel does not delete an existing cache entry", async () => {
  const f = fixture();
  f.cache([model]);
  const run = f.download.download(EXAMPLE_MODEL_URL, () => {});
  f.download.cancel();
  await assert.rejects(run, /中止/);
  assert.deepEqual(f.deleted, []);
});
test("invalid completed size and network failures do not register a model", async () => {
  const f = fixture();
  f.fetch(async () => ({ ...model, validate: () => "invalid" }) as Model);
  await assert.rejects(
    f.download.download(EXAMPLE_MODEL_URL, () => {}),
    /サイズ/,
  );
  assert.equal(f.deleted.length, 1);
  f.fetch(async () => {
    throw new Error("HTTP 403");
  });
  await assert.rejects(
    f.download.download(EXAMPLE_MODEL_URL, () => {}),
    /DOWNLOAD|403/,
  );
});
