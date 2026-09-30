import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseStartupModel,
  DEFAULT_RUNTIME_SETTINGS as defaults,
  readRuntimeSettings,
  validateRuntimeSettings,
} from "../../src/inference/runtime-settings";
import { managerResponseTimeoutMs } from "../../src/extension/judge-channel";
const model = (id: string, gib: number) => ({
  id: `cache:${id}`,
  label: id,
  size: gib * 1024 ** 3,
});
const models = [model("large", 16), model("small", 0.5), model("medium", 2)];
test("startup restores small models but substitutes the smallest cached model for large, missing, or unknown sizes", () => {
  assert.equal(
    chooseStartupModel(defaults, "cache:large", models).model?.id,
    "cache:small",
  );
  assert.equal(
    chooseStartupModel(defaults, "cache:medium", models).model?.id,
    "cache:medium",
  );
  assert.equal(
    chooseStartupModel(defaults, "local:file", models).model?.id,
    "cache:small",
  );
  assert.equal(
    chooseStartupModel(defaults, "cache:unknown", [
      ...models,
      model("unknown", -1),
    ]).model?.id,
    "cache:small",
  );
  assert.equal(
    chooseStartupModel(defaults, undefined, models).model,
    undefined,
  );
});
test("explicit fallback must be cached and within the limit; unavailable fallback never loads a heavy model", () => {
  assert.equal(
    chooseStartupModel(
      { ...defaults, fallbackModel: "cache:medium" },
      "cache:large",
      models,
    ).model?.id,
    "cache:medium",
  );
  for (const fallbackModel of ["cache:large", "cache:deleted"])
    assert.equal(
      chooseStartupModel({ ...defaults, fallbackModel }, "cache:large", models)
        .model,
      undefined,
    );
  assert.equal(
    chooseStartupModel(defaults, "cache:large", [models[0]]).model,
    undefined,
  );
  assert.equal(
    chooseStartupModel(defaults, "cache:large", [
      { ...models[1], id: "local:file" },
    ]).model,
    undefined,
  );
});
test("startup off and unrestricted last-model mode honor the user's selection", () => {
  assert.equal(
    chooseStartupModel({ ...defaults, startup: "none" }, "cache:small", models)
      .model,
    undefined,
  );
  assert.equal(
    chooseStartupModel({ ...defaults, startup: "last" }, "cache:large", models)
      .model?.id,
    "cache:large",
  );
  assert.equal(
    chooseStartupModel(
      { ...defaults, maxAutoLoadGiB: 16 },
      "cache:large",
      models,
    ).model?.id,
    "cache:large",
  );
});
test("settings persist, default safely for old installs, and reject invalid timeouts", () => {
  for (const raw of [null, "{", "{}"])
    assert.deepEqual(readRuntimeSettings({ getItem: () => raw }), defaults);
  const longer = { ...defaults, loadSeconds: 900, responseSeconds: 1800 };
  assert.deepEqual(
    readRuntimeSettings({ getItem: () => JSON.stringify(longer) }),
    longer,
  );
  for (const responseSeconds of [0, -1, NaN, 3601, 0.5])
    assert.throws(() =>
      validateRuntimeSettings({ ...defaults, responseSeconds }),
    );
  assert.equal(managerResponseTimeoutMs({ responseSeconds: 1800 }), 1950000);
  assert.equal(managerResponseTimeoutMs({ responseSeconds: NaN }), 390000);
});
