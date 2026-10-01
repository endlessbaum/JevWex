import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesUrl,
  matchingRules,
  normalizeUrl,
  validateRule,
  setRuleEnabled,
  setRuleWatchInput,
  RULE_PREFIX,
  readRules,
  saveRule,
  type SiteRule,
} from "../../src/extension/site-rules";
import { scopeKey } from "../../src/extension/content-scope";

test("disabled matching rules are available for toggles but excluded from execution", () => {
  const disabled = { ...rule, enabled: false };
  assert.deepEqual(matchingRules([disabled], rule.url), []);
  assert.deepEqual(matchingRules([disabled], rule.url, true), [disabled]);
  assert.deepEqual(
    matchingRules([disabled], "https://unrelated.example/", true),
    [],
  );
});
test("toggling reads the latest criteria and does not recreate deleted rules", async () => {
  const key = RULE_PREFIX + rule.id;
  const data: Record<string, unknown> = {
    [key]: { ...rule, name: "別画面で編集済み" },
  };
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get: async () => structuredClone(data),
          set: async (values: Record<string, unknown>) => {
            Object.assign(data, values);
          },
        },
      },
    },
  });
  const saved = await setRuleEnabled(rule.id, false);
  assert.equal(saved.name, "別画面で編集済み");
  assert.equal(saved.enabled, false);
  assert.deepEqual(saved.criteria, rule.criteria);
  delete data[key];
  await assert.rejects(setRuleEnabled(rule.id, true), /削除/);
  assert.deepEqual(data, {});
});

const rule: SiteRule = {
  id: "test",
  name: "記事",
  url: "https://example.com/news?view=all",
  scope: "exact",
  enabled: true,
  criteria: [
    {
      id: "topic",
      alias: "分類",
      type: "noul",
      instructions: "技術の記事である",
      labels: [],
    },
  ],
};

test("input monitoring is opt-in and requires an explicit input target", () => {
  assert.equal(validateRule(rule).watchInput, undefined);
  assert.throws(() => validateRule({ ...rule, watchInput: "on" }), /確認/);
  assert.throws(() => validateRule({ ...rule, watchInput: true }), /入力欄/);
  const scope = { root: "#message", exclude: [], inputValue: true };
  assert.equal(
    validateRule({ ...rule, contentScope: scope, watchInput: true }).watchInput,
    true,
  );
  for (const invalid of [
    { ...scope, inputValue: "yes" },
    { ...scope, root: null },
    { ...scope, items: ":scope > input" },
    { ...scope, images: true },
    { ...scope, linkedPages: true },
  ])
    assert.throws(
      () => validateRule({ ...rule, contentScope: invalid }),
      /本文範囲/,
    );
});

test("watch toggles preserve concurrent criteria changes and never restore deleted rules", async () => {
  const key = RULE_PREFIX + rule.id;
  const data: Record<string, unknown> = {
    [key]: {
      ...rule,
      name: "最新の条件",
      enabled: false,
      contentScope: { root: "#message", exclude: [], inputValue: true },
    },
  };
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get: async () => structuredClone(data),
          set: async (values: Record<string, unknown>) =>
            Object.assign(data, values),
        },
      },
    },
  });
  const enabled = await setRuleWatchInput(rule.id, true);
  assert.equal(enabled.name, "最新の条件");
  assert.equal(enabled.enabled, false);
  assert.equal(enabled.watchInput, true);
  assert.deepEqual(enabled.criteria, rule.criteria);
  assert.equal((await setRuleWatchInput(rule.id, false)).watchInput, undefined);
  delete data[key];
  await assert.rejects(setRuleWatchInput(rule.id, true), /削除/);
});

test("exact URL ignores fragments, preserves queries and origin boundaries", () => {
  assert.equal(matchesUrl(rule, rule.url + "#heading"), true);
  for (const url of [
    "https://example.com/news",
    "https://example.com/news?view=other",
    "http://example.com/news?view=all",
    "https://example.com.evil.org/news?view=all",
    "https://sub.example.com/news?view=all",
    "https://example.com:8443/news?view=all",
    "javascript:alert(1)",
  ])
    assert.equal(matchesUrl(rule, url), false, url);
  assert.equal(
    normalizeUrl("https://EXAMPLE.com:443/a/../news?view=all#x"),
    rule.url,
  );
});
test("subtree matches path segments, ignores queries, and does not include siblings", () => {
  const subtree = {
    ...rule,
    scope: "subtree" as const,
    url: "https://example.com/news/",
  };
  for (const path of ["/news", "/news/", "/news/article?p=1#x"])
    assert.equal(matchesUrl(subtree, "https://example.com" + path), true);
  for (const path of [
    "/newsletter",
    "/newspaper/a",
    "/news%2Fprivate",
    "/news/../other",
  ])
    assert.equal(matchesUrl(subtree, "https://example.com" + path), false);
  assert.equal(
    matchesUrl(
      { ...subtree, url: "https://example.com/" },
      "https://example.com/anything",
    ),
    true,
  );
});
test("specific matches win deterministically, disabled rules never match", () => {
  const origin = { ...rule, id: "origin", scope: "origin" as const };
  const subtree = { ...rule, id: "subtree", scope: "subtree" as const };
  assert.deepEqual(
    matchingRules(
      [origin, subtree, { ...rule, id: "disabled", enabled: false }, rule],
      rule.url,
    ).map((r) => r.id),
    ["test", "subtree", "origin"],
  );
  assert.equal(matchesUrl(origin, "https://example.com/other?q=1"), true);
  assert.equal(matchesUrl(origin, "http://example.com/other"), false);
});
test("saved criteria validate and retain aliases, label ordering and IDs without retaining page content", () => {
  const saved = validateRule({
    ...rule,
    state: "private page",
    name: " 記事 ",
    url: rule.url + "#x",
  });
  assert.equal(saved.name, "記事");
  assert.equal(saved.url, rule.url);
  assert.equal(Object.hasOwn(saved, "state"), false);
  assert.deepEqual(saved.criteria, rule.criteria);
  assert.notEqual(saved.criteria, rule.criteria);
  for (const update of [
    { url: "file:///secret" },
    { url: "https://user:password@example.com" },
    { scope: "bogus" },
    { name: " " },
    { criteria: [] },
    { criteria: [{ ...rule.criteria[0], instructions: "" }] },
    { criteria: [{ ...rule.criteria[0], type: "invalid" }] },
  ])
    assert.throws(() => validateRule({ ...rule, ...update }));
});

test("legacy URL targets migrate once into each rule and later draft edits cannot change them", async () => {
  const target = { root: "#list", exclude: [], items: ":scope > li" };
  const data: Record<string, any> = {
    [RULE_PREFIX + rule.id]: structuredClone(rule),
    [scopeKey(rule.url)]: target,
  };
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get: async () => structuredClone(data),
          set: async (values: Record<string, unknown>) => {
            Object.assign(data, structuredClone(values));
          },
        },
      },
    },
  });
  assert.deepEqual((await readRules())[0].contentScope, target);
  data[scopeKey(rule.url)] = { root: "#other", exclude: [] };
  assert.deepEqual((await readRules())[0].contentScope, target);
  assert.deepEqual((await setRuleEnabled(rule.id, false)).contentScope, target);
});

test("target and criteria save together and stale edits cannot overwrite a changed target", async () => {
  const data: Record<string, any> = {};
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get: async () => structuredClone(data),
          set: async (values: Record<string, unknown>) => {
            Object.assign(data, structuredClone(values));
          },
        },
      },
    },
  });
  const target = { root: "#article", exclude: ["#ad"] };
  const original = await saveRule({ ...rule, contentScope: target });
  assert.deepEqual(original.contentScope, target);
  const modified = await saveRule(
    { ...original, contentScope: { root: "#other", exclude: [] } },
    original,
  );
  await assert.rejects(
    saveRule({ ...original, name: "stale" }, original),
    /別の画面/,
  );
  assert.deepEqual((await readRules())[0], modified);
  assert.throws(() =>
    validateRule({ ...rule, contentScope: { root: "", exclude: [] } }),
  );
});
