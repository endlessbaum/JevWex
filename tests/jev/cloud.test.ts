import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCloud,
  validateJevResponse,
} from "../../src/inference/cloud-evaluate";
import {
  CLOUD_DEFAULTS,
  CLOUD_SETTINGS_KEY,
  readCloudSettings,
  saveCloudSettings,
  validateCloudSettings,
  readCloudProfiles,
  saveCloudProfiles,
  type CloudConnection,
} from "../../src/inference/cloud-settings";
import { DecisionSession } from "../../src/inference/decision-session";
import type { Runtime } from "../../src/inference/model-session";
import { type JevInput } from "../../src/features/jev/types";
import { newBatch, runBatch } from "../../src/features/jev/batch";
import { managerResponseTimeoutMs } from "../../src/extension/judge-channel";
import { gguf, response } from "../fixtures/readout";

const input: JevInput = {
  state: { text: "A cat" },
  questions: {
    pick: {
      type: "choice",
      instructions: "Animal?",
      criteria: { cat: null, dog: "Dog" },
    },
    level: {
      type: "score",
      instructions: "Detail?",
      criteria: ["low", { label: "high" }],
    },
    yes: { type: "noul", instructions: "A cat?" },
  },
};
const single: JevInput = { ...input, questions: { yes: input.questions.yes } };
const config: CloudConnection = {
  ...CLOUD_DEFAULTS.jev,
  apiKey: "test-secret",
  fallback: false,
};
const snapshot = {
  model: "cloud:jev:jev-latest",
  generation: -1,
  load_ms: 0,
  threads: 0,
  context: 0,
};
const result = {
  model: "jev-1.13.0",
  answers: {
    pick: {
      type: "choice",
      choice: "cat",
      probabilities: { cat: 0.8, dog: 0.2 },
      confidence: 0.59,
    },
    level: {
      type: "score",
      score: 0.7,
      probabilities: { "0": 0.3, "1": 0.7 },
      confidence: 0.38,
      legend: { "0": "low", "1": '{"label":"high"}' },
    },
    yes: { type: "noul", noul: 0.9 },
  },
};
const jsonFetch =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });
const waitingFetch: typeof fetch = async (_, init) =>
  new Promise((_, reject) => {
    init!.signal!.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
function fixture(
  fetcher: typeof fetch = jsonFetch({
    model: "jev",
    answers: { yes: result.answers.yes },
  }),
  images = false,
) {
  let calls = 0;
  const session = new DecisionSession(
    () =>
      ({
        loadModel: async () => {},
        exit: async () => {},
        getChatTemplate: () => "template",
        getNumThreads: () => 1,
        getLoadedContextInfo: () => ({ n_ctx: 4096, has_image_input: images }),
        createChatCompletion: async () => {
          calls++;
          return response();
        },
      }) as Runtime,
    undefined,
    fetcher,
  );
  session.register({
    id: "local:test",
    label: "Local",
    size: 1,
    source: [gguf()],
  });
  return { session, calls: () => calls };
}
test("cloud sends the official JEV contract, preserves provider values, and omits secrets from results", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.deepEqual(JSON.parse(init!.body as string), {
      ...input,
      model: "jev-latest",
    });
    assert.equal(
      new Headers(init!.headers).get("authorization"),
      "Bearer test-secret",
    );
    assert.equal(init!.redirect, "error");
    assert.equal(init!.credentials, "omit");
    return new Response(JSON.stringify(result));
  };
  const actual = await evaluateCloud(
    config,
    input,
    snapshot,
    undefined,
    fetcher,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(actual.response)), result);
  assert.equal(actual.diagnostics.readout_method, "jev_api");
  assert.equal(actual.diagnostics.confidence_method, "provider");
  assert.doesNotMatch(JSON.stringify(actual), /test-secret|wllama_version/);
});
test("rejects missing/extra questions, bad labels, sums, score, legend and nonfinite probabilities", () => {
  const mutations = [
    (r: any) => delete r.answers.yes,
    (r: any) => (r.answers.extra = r.answers.yes),
    (r: any) => (r.answers.yes.noul = NaN),
    (r: any) => (r.answers.pick.choice = "dog"),
    (r: any) => (r.answers.pick.probabilities.cat = 2),
    (r: any) => (r.answers.pick.probabilities = { cat: 0.8, fish: 0.2 }),
    (r: any) => (r.answers.pick.probabilities.cat = 0.7),
    (r: any) => (r.answers.pick.confidence = -1),
    (r: any) => (r.answers.level.score = 0.1),
    (r: any) => delete r.answers.level.legend,
    (r: any) => (r.answers.level.type = "choice"),
  ];
  for (const mutate of mutations) {
    const broken = structuredClone(result);
    mutate(broken);
    assert.throws(() => validateJevResponse(broken, input), {
      code: "INVALID_OUTPUT",
    });
  }
});
test("prototype-like IDs and labels are data", () => {
  const request = JSON.parse(
    '{"state":"x","questions":{"__proto__":{"type":"choice","instructions":"x","criteria":{"constructor":null,"__proto__":null}}}}',
  );
  const answer = JSON.parse(
    '{"model":"jev","answers":{"__proto__":{"type":"choice","choice":"__proto__","probabilities":{"constructor":0.2,"__proto__":0.8},"confidence":0.6}}}',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(validateJevResponse(answer, request))),
    answer,
  );
});
test("JevWex HTTP response envelope is supported without trusting remote diagnostics", () => {
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        validateJevResponse(
          { response: result, diagnostics: { apiKey: "secret" } },
          input,
        ),
      ),
    ),
    result,
  );
});
test("settings persist only whitelisted non-secret fields; corrupt storage keeps defaults", () => {
  let raw = "{}";
  const storage = {
    getItem: () => raw,
    setItem: (key: string, value: string) => {
      assert.equal(key, CLOUD_SETTINGS_KEY);
      raw = value;
    },
  };
  saveCloudSettings(storage, config);
  assert.doesNotMatch(raw, /test-secret|apiKey|active/);
  assert.equal(readCloudSettings(storage, "jev").endpoint, config.endpoint);
  raw = "broken";
  assert.deepEqual(readCloudSettings(storage, "jev"), CLOUD_DEFAULTS.jev);
  for (const endpoint of [
    "http://example.com/api",
    "https://u:p@example.com/api",
    "https://example.com/api?key=secret",
    "https://example.com/api#x",
    "file:///secret",
  ])
    assert.throws(() => validateCloudSettings({ ...config, endpoint }));
  assert.equal(
    validateCloudSettings({
      ...config,
      endpoint: "http://127.0.0.1:8000/evaluate",
    }).endpoint,
    "http://127.0.0.1:8000/evaluate",
  );
});
test("local is default; cloud works without local when fallback is disabled", async () => {
  const { session, calls } = fixture();
  assert.equal(session.cloud, undefined);
  assert.equal(session.phase, "empty");
  assert.throws(() => session.useCloud({ ...config, fallback: true }), {
    code: "MODEL_NOT_LOADED",
  });
  session.useCloud(config);
  assert.equal(session.phase, "ready");
  const out = await session.evaluate(single);
  assert.equal(out.response.model, "jev");
  assert.equal(calls(), 0);
  session.useLocal();
  assert.equal(session.loaded, null);
  assert.equal(session.phase, "empty");
});
test("profile metadata is persisted without keys and profiles sharing a model have distinct session identities", async () => {
  let raw = "[]";
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, text: string) => {
      raw = text;
    },
  };
  const profiles = ["first", "second"].map((id) => ({
    ...config,
    id,
    name: id,
  }));
  saveCloudProfiles(storage, profiles);
  assert.doesNotMatch(raw, /apiKey|test-secret/);
  assert.deepEqual(
    readCloudProfiles(storage).map((p) => p.id),
    ["first", "second"],
  );
  assert.throws(() => saveCloudProfiles(storage, [profiles[0], profiles[0]]), {
    code: "INVALID_REQUEST",
  });
  const { session } = fixture();
  session.useCloud({ ...config, profileId: "first" });
  assert.equal(session.loaded?.model, "cloud:jev:first");
  session.useCloud({ ...config, profileId: "second" });
  assert.equal(session.cloud?.profileId, "second");
  assert.equal(session.loaded?.model, "cloud:jev:second");
  assert.throws(
    () => session.evaluate({ ...single, model: "cloud:jev:first" }),
    { code: "INVALID_REQUEST" },
  );
  const evaluated = await session.evaluate({
    ...single,
    model: "cloud:jev:second",
  });
  assert.equal(evaluated.response.model, "jev");
  raw = "broken";
  assert.deepEqual(readCloudProfiles(storage), []);
});
test("local-only mode never calls cloud; selecting local releases cloud credentials", async () => {
  const { session, calls } = fixture(async () => {
    throw new Error("Must not call cloud");
  });
  await session.load();
  await session.evaluate(single);
  session.useCloud({ ...config, fallback: true });
  session.useLocal();
  await session.evaluate(single);
  assert.equal(calls(), 2);
  assert.equal(session.cloud, undefined);
});
for (const [name, fetcher] of [
  ["unauthorized", jsonFetch({ error: "test-secret" }, 401)],
  ["rate limit", jsonFetch({}, 429)],
  ["server failure", jsonFetch({}, 503)],
  ["invalid response", jsonFetch({})],
  [
    "network failure",
    async () => {
      throw new Error("test-secret");
    },
  ],
] as const)
  test(`${name} falls back once and reports the actual local model`, async () => {
    const { session, calls } = fixture(fetcher);
    await session.load();
    session.useCloud({ ...config, fallback: true });
    const out = await session.evaluate({
      ...single,
      model: session.loaded!.model,
    });
    assert.equal(out.response.model, "local:test");
    assert.equal(calls(), 1);
    assert.equal(out.diagnostics.fallback?.from, "jev");
    assert.doesNotMatch(JSON.stringify(out), /test-secret/);
    assert.equal(session.phase, "ready");
  });
test("disabled fallback propagates failures without local inference", async () => {
  const { session, calls } = fixture(jsonFetch({}, 500));
  await session.load();
  session.useCloud(config);
  await assert.rejects(session.evaluate(single), {
    code: "RUNTIME_UNAVAILABLE",
  });
  assert.equal(calls(), 0);
});
test("timeout falls back; cancellation does not; concurrent calls and provider changes are rejected", async () => {
  const { session, calls } = fixture(waitingFetch);
  await session.load();
  session.useCloud({ ...config, fallback: true, timeoutSeconds: 1 });
  const out = await session.evaluate(single);
  assert.match(out.diagnostics.fallback!.reason, /1/);
  assert.equal(calls(), 1);
  const pending = session.evaluate(single);
  await assert.rejects(session.evaluate(single), { code: "BUSY" });
  assert.throws(() => session.useLocal(), { code: "BUSY" });
  const rejected = assert.rejects(pending, { code: "CANCELLED" });
  await session.stop();
  await rejected;
  assert.equal(calls(), 1);
  assert.equal(session.phase, "ready");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(session.evaluate(single, controller.signal), {
    code: "CANCELLED",
  });
  assert.equal(calls(), 1);
});
test("batch cloud IDs remain routable and per-row fallback keeps the actual model", async () => {
  const { session } = fixture(jsonFetch({}, 503));
  await session.load();
  session.useCloud({ ...config, fallback: true });
  const batch = newBatch(
    [
      { number: 1, name: "one", text: "a" },
      { number: 2, name: "two", text: "b" },
    ],
    single.questions,
    session.loaded!,
  );
  await runBatch(
    batch,
    (request, signal) => session.evaluate(request, signal),
    new AbortController().signal,
    () => {},
  );
  assert.ok(
    batch.rows.every(
      (row) =>
        row.status === "success" &&
        row.result?.response.model === "local:test" &&
        row.result?.diagnostics.fallback?.from === "jev",
    ),
  );
});

test("images use the complete local input without any cloud request", async () => {
  let network = 0;
  const { session, calls } = fixture(async () => {
    network++;
    throw new Error("Unexpected request");
  }, true);
  await session.load();
  session.useCloud({ ...config, fallback: true });
  const images = [
    {
      name: "cat.png",
      type: "image/png",
      size: 1,
      width: 1,
      height: 1,
      data: new ArrayBuffer(1),
    },
  ];
  const out = await session.evaluate(single, undefined, images);
  assert.equal(network, 0);
  assert.equal(calls(), 1);
  assert.equal(out.diagnostics.images?.[0].name, "cat.png");
  session.useCloud(config);
  await assert.rejects(session.evaluate(single, undefined, images), {
    code: "MODEL_UNSUPPORTED",
  });
  assert.equal(network, 0);
  assert.equal(calls(), 1);
});
test("page bridge budgets cloud timeout plus local fallback time", () => {
  assert.equal(
    managerResponseTimeoutMs({ responseSeconds: 3600, cloudSeconds: 600 }),
    4350000,
  );
  assert.equal(
    managerResponseTimeoutMs({ responseSeconds: 0, cloudSeconds: 60 }),
    450000,
  );
});
