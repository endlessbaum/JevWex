import test from "node:test";
import assert from "node:assert/strict";
import {
  readLastModel,
  saveLastModel,
  LAST_MODEL_STORAGE_KEY,
} from "../../src/inference/last-model";

test("last model stores identity and name without file data or input", () => {
  let saved = "";
  assert.equal(
    saveLastModel(
      {
        setItem: (key, value) => {
          assert.equal(key, LAST_MODEL_STORAGE_KEY);
          saved = value;
        },
      },
      {
        id: "cache:https://huggingface.co/owner/repo/resolve/main/model.gguf",
        label: "画像モデル",
      },
    ),
    true,
  );
  assert.deepEqual(Object.keys(JSON.parse(saved)), ["id", "label"]);
  assert.equal(readLastModel({ getItem: () => saved })?.label, "画像モデル");
  assert.deepEqual(
    readLastModel({
      getItem: () =>
        JSON.stringify({ id: "local:a.gguf:10:12", label: "a.gguf" }),
    }),
    { id: "local:a.gguf:10:12", label: "a.gguf" },
  );
});
test("invalid persisted model and unavailable storage do not prevent startup", () => {
  for (const value of [
    null,
    "{",
    "null",
    "{}",
    '"text"',
    '{"id":"cache:","label":"empty"}',
    '{"id":"remote:x","label":"x"}',
    '{"id":"local:x","label":2}',
  ])
    assert.equal(readLastModel({ getItem: () => value }), undefined);
  assert.equal(
    readLastModel({
      getItem: () => {
        throw new Error("disabled");
      },
    }),
    undefined,
  );
  assert.equal(
    saveLastModel(
      {
        setItem: () => {
          throw new Error("quota");
        },
      },
      { id: "local:x", label: "x" },
    ),
    false,
  );
});
