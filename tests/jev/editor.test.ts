import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInput,
  draftFromQuestion,
  type CriterionDraft,
} from "../../src/pages/jev/criteria-editor";
import { examples } from "../../src/features/jev/examples";
const draft: CriterionDraft = {
  id: "stable-id",
  alias: "対応の具体性",
  type: "score",
  instructions: "説明の具体性を評価",
  labels: [
    { label: "低い", description: "具体的な記述なし" },
    { label: "高い", description: "具体的な記述あり" },
  ],
};
test("display alias stays separate from stable request id and instructions", () => {
  const a = buildInput("文章", [draft]);
  const b = buildInput("文章", [{ ...draft, alias: "新しい基準名" }]);
  assert.deepEqual(a.input, b.input);
  assert.equal(b.presentation["stable-id"].alias, "新しい基準名");
  assert.equal(JSON.stringify(b.input).includes("新しい基準名"), false);
});
test("score labels and descriptions preserve ordered stages in model input and export", () => {
  const { input, presentation } = buildInput("文章", [draft]);
  assert.deepEqual(input.questions["stable-id"].criteria, draft.labels);
  assert.deepEqual(presentation["stable-id"].labels, ["低い", "高い"]);
  const reverse = buildInput("文章", [
    { ...draft, labels: [...draft.labels].reverse() },
  ]);
  assert.deepEqual(
    reverse.input.questions["stable-id"].criteria,
    [...draft.labels].reverse(),
  );
});
test("choice label descriptions become a safe dictionary; noul has no stale labels", () => {
  const choice = {
    ...draft,
    type: "choice" as const,
    labels: [
      { label: "__proto__", description: "a" },
      { label: "constructor", description: "b" },
    ],
  };
  assert.equal(
    Object.hasOwn(
      buildInput("文章", [choice]).input.questions["stable-id"].criteria!,
      "__proto__",
    ),
    true,
  );
  const noul = buildInput("文章", [{ ...draft, type: "noul" }]);
  assert.equal(
    Object.hasOwn(noul.input.questions["stable-id"], "criteria"),
    false,
  );
});
test("editor rejects blank aliases, repeated labels, and invalid counts using user vocabulary", () => {
  for (const changed of [
    { alias: " " },
    { instructions: "" },
    { labels: [] },
    { labels: [draft.labels[0]] },
    { labels: [draft.labels[0], draft.labels[0]] },
    { labels: [{ label: "", description: "a" }, draft.labels[1]] },
  ]) {
    assert.throws(
      () => buildInput("文章", [{ ...draft, ...changed }]),
      /基準名|判定する内容・条件|段階|ラベル/,
    );
  }
  assert.throws(() => buildInput(" ", [draft]), /判定する文章/);
  assert.throws(() => buildInput("文章", []), /判定基準/);
});
test("all samples can become text-only editable drafts", () => {
  for (const sample of examples) {
    const drafts = Object.entries(sample.input.questions).map(([id, q]) =>
      draftFromQuestion(id, q),
    );
    const { input } = buildInput("サンプルの文章", drafts);
    assert.equal(Object.keys(input.questions).length, drafts.length);
  }
});
