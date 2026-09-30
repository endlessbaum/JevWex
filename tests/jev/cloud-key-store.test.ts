import test from "node:test";
import assert from "node:assert/strict";
import {
  CloudKeyStore,
  CLOUD_CREDENTIALS_KEY,
  isCloudSettingsSender,
  normalizeApiKey,
} from "../../src/extension/cloud-key-store";
import { CLOUD_DEFAULTS } from "../../src/inference/cloud-settings";

const settings = { ...CLOUD_DEFAULTS.jev, fallback: false };
const input = {
  state: "Astronomy",
  questions: { yes: { type: "noul", instructions: "Astronomy?" } },
};
const signal = () => new AbortController().signal;
function fixture(
  fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        model: "jev-test",
        answers: { yes: { type: "noul", noul: 0.9 } },
      }),
    ),
) {
  let trusted = false;
  const data: Record<string, unknown> = {};
  const storage = {
    get: async (key: string) => {
      assert.ok(trusted);
      return { [key]: data[key] };
    },
    set: async (values: Record<string, unknown>) => {
      assert.ok(trusted);
      Object.assign(data, structuredClone(values));
    },
    remove: async (key: string) => {
      assert.ok(trusted);
      delete data[key];
    },
    setAccessLevel: async (value: { accessLevel: string }) => {
      assert.equal(value.accessLevel, "TRUSTED_CONTEXTS");
      trusted = true;
    },
  } as unknown as chrome.storage.StorageArea;
  return {
    data,
    storage,
    service: new CloudKeyStore(storage, async () => true, fetcher),
  };
}
test("BYOK persists across worker restarts, reports only configuration, overwrites and deletes without history", async () => {
  const { service, storage, data } = fixture();
  assert.deepEqual(await service.status(), { configured: false, profiles: [] });
  await service.save(settings, " old-key ");
  const restarted = new CloudKeyStore(storage, async () => true);
  assert.deepEqual(await restarted.status(), {
    configured: true,
    settings,
    profileId: "legacy",
    profiles: [{ ...settings, id: "legacy", name: settings.model }],
  });
  assert.doesNotMatch(JSON.stringify(await restarted.status()), /old-key/);
  await restarted.save({ ...settings, timeoutSeconds: 20 }, "");
  assert.match(JSON.stringify(data), /old-key/);
  await restarted.save(settings, "new-key");
  assert.doesNotMatch(JSON.stringify(data), /old-key/);
  await restarted.remove();
  assert.deepEqual(data, {});
  assert.deepEqual(await service.status(), { configured: false, profiles: [] });
});
test("keys accept provider-independent formats but reject empty, overlong and multiline keys", () => {
  assert.equal(normalizeApiKey(" custom_format-123 "), "custom_format-123");
  for (const key of ["", "   ", "x".repeat(8193), "a\nb", "a\rb", null])
    assert.throws(() => normalizeApiKey(key));
});
test("multiple profiles route independently even with identical endpoints/models, and deleting one preserves the others", async () => {
  const calls: string[] = [];
  const { service, storage, data } = fixture(async (_url, init) => {
    calls.push((init!.headers as Record<string, string>).Authorization);
    return new Response(
      JSON.stringify({
        model: "fixture",
        answers: { yes: { type: "noul", noul: 0.9 } },
      }),
    );
  });
  await Promise.all([
    service.save(settings, "alpha-key", "alpha", "Alpha API"),
    service.save(settings, "beta-key", "beta", "Beta API"),
  ]);
  const restarted = new CloudKeyStore(
    storage,
    async () => true,
    async (_url, init) => {
      calls.push((init!.headers as Record<string, string>).Authorization);
      return new Response(
        JSON.stringify({
          model: "fixture",
          answers: { yes: { type: "noul", noul: 0.9 } },
        }),
      );
    },
  );
  assert.equal((await restarted.status()).profiles.length, 2);
  assert.doesNotMatch(
    JSON.stringify(await restarted.status()),
    /alpha-key|beta-key/,
  );
  await restarted.evaluate(input, settings, signal(), "beta");
  await restarted.evaluate(input, settings, signal(), "alpha");
  assert.deepEqual(calls, ["Bearer beta-key", "Bearer alpha-key"]);
  await restarted.save(
    { ...settings, timeoutSeconds: 22 },
    "",
    "alpha",
    "Renamed API",
  );
  assert.equal(
    (await restarted.status("alpha")).profiles[0].name,
    "Renamed API",
  );
  await assert.rejects(restarted.evaluate(input, settings, signal(), "alpha"), {
    code: "INVALID_REQUEST",
  });
  await assert.rejects(restarted.save(settings, "", "new-profile", "New"), {
    code: "API_KEY_NOT_CONFIGURED",
  });
  await restarted.remove("alpha");
  assert.equal((await restarted.status("alpha")).configured, false);
  assert.deepEqual(
    (await restarted.status()).profiles.map((p) => p.id),
    ["beta"],
  );
  assert.doesNotMatch(JSON.stringify(data), /alpha-key/);
  await restarted.evaluate(input, settings, signal(), "beta");
  await assert.rejects(restarted.evaluate(input, settings, signal(), "alpha"), {
    code: "API_KEY_NOT_CONFIGURED",
  });
  await assert.rejects(
    restarted.save(settings, "bad-key", "../bad", "Invalid"),
    { code: "INVALID_REQUEST" },
  );
  await restarted.remove("beta");
  assert.deepEqual(data, {});
});
test("legacy credentials remain usable and migrate on save without leaving a duplicate key", async () => {
  const { service, data } = fixture();
  data[CLOUD_CREDENTIALS_KEY] = { ...settings, apiKey: "legacy-key" };
  const initial = await service.status();
  assert.equal(initial.profiles[0].id, "legacy");
  await service.save(settings, "other-key", "other", "Other API");
  const persisted = data[CLOUD_CREDENTIALS_KEY] as {
    version: number;
    profiles: unknown[];
    apiKey?: string;
  };
  assert.equal(persisted.version, 2);
  assert.equal(persisted.profiles.length, 2);
  assert.equal(persisted.apiKey, undefined);
  await service.evaluate(input, settings, signal(), "legacy");
  await service.remove("other");
  assert.equal((await service.status()).profileId, "legacy");
  assert.doesNotMatch(
    JSON.stringify(await service.status()),
    /legacy-key|other-key/,
  );
});
test("requests require a stored key and saved settings; changing endpoints cannot reuse a key", async () => {
  let calls = 0;
  const { service } = fixture(async (url, init) => {
    calls++;
    assert.equal(url, settings.endpoint);
    assert.equal(
      (init!.headers as Record<string, string>).Authorization,
      "Bearer byok-key",
    );
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    return new Response(
      JSON.stringify({
        model: "jev-test",
        answers: { yes: { type: "noul", noul: 0.9 } },
      }),
    );
  });
  await assert.rejects(service.evaluate(input, settings, signal()), {
    code: "API_KEY_NOT_CONFIGURED",
  });
  assert.equal(calls, 0);
  await service.save(settings, "byok-key");
  const different = { ...settings, endpoint: "https://unrelated.example/api" };
  await assert.rejects(service.save(different, ""), {
    code: "API_KEY_NOT_CONFIGURED",
  });
  await assert.rejects(service.evaluate(input, different, signal()), {
    code: "INVALID_REQUEST",
  });
  assert.equal(calls, 0);
  const result = await service.evaluate(input, settings, signal());
  assert.equal(result.response.model, "jev-test");
  assert.doesNotMatch(JSON.stringify(result), /byok-key/);
  await service.remove();
  await assert.rejects(service.evaluate(input, settings, signal()), {
    code: "API_KEY_NOT_CONFIGURED",
  });
  assert.equal(calls, 1);
});
test("authentication, limits and network errors never disclose provider bodies or keys", async () => {
  for (const [status, code] of [
    [401, "AUTHENTICATION_FAILED"],
    [403, "AUTHENTICATION_FAILED"],
    [429, "RATE_LIMITED"],
    [503, "API_ERROR"],
  ] as const) {
    const { service } = fixture(
      async () =>
        new Response("Authorization: Bearer sensitive-key", { status }),
    );
    await service.save(settings, "sensitive-key");
    await assert.rejects(
      service.evaluate(input, settings, signal()),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, code);
        assert.doesNotMatch(
          String(error),
          /sensitive-key|Authorization|Bearer/,
        );
        return true;
      },
    );
  }
  const { service } = fixture(async () => {
    throw new Error("sensitive-key");
  });
  await service.save(settings, "sensitive-key");
  await assert.rejects(service.evaluate(input, settings, signal()), {
    code: "NETWORK_ERROR",
  });
});
test("provider echoes of credentials in otherwise valid JSON cannot reach UI/results", async () => {
  const { service } = fixture(
    async () =>
      new Response(
        JSON.stringify({
          model: "secret-key",
          answers: { yes: { type: "noul", noul: 0.9 } },
        }),
      ),
  );
  await service.save(settings, "secret-key");
  await assert.rejects(
    service.evaluate(input, settings, signal()),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "INVALID_OUTPUT");
      assert.doesNotMatch(String(error), /secret-key/);
      return true;
    },
  );
});
test("only same-extension top-level model settings pages may access BYOK commands", () => {
  const getUrl = (path: string) => "chrome-extension://self/" + path;
  const valid = {
    id: "self",
    url: getUrl("index.html") + "#models",
    frameId: 0,
  };
  assert.equal(isCloudSettingsSender(valid, "self", getUrl), true);
  for (const changed of [
    { id: "other" },
    { url: "https://example.com/index.html" },
    { url: getUrl("panel.html") },
    { url: getUrl("index.html.evil") },
    { frameId: 1 },
  ])
    assert.equal(
      isCloudSettingsSender({ ...valid, ...changed }, "self", getUrl),
      false,
    );
});
