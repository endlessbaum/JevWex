import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJson,
  validateRequest,
  fromForm,
} from "../../src/features/jev/validate";
import { examples } from "../../src/features/jev/examples";
import { messages } from "../../src/features/jev/prompts";
import {
  answerFromProbabilities,
  confidence,
} from "../../src/features/jev/result-math";
import type { Question } from "../../src/features/jev/types";
const choice: Question = {
  type: "choice",
  instructions: "select",
  criteria: { a: null, b: { 説明: ['改行\n引用"', "日本語"] } },
};
const score: Question = {
  type: "score",
  instructions: ["rate"],
  criteria: ["low", { detail: "middle" }, ["high"]],
};
test("all examples and structured instructions validate", () => {
  examples.forEach((x) => validateRequest(x.input));
  validateRequest({
    state: [],
    questions: {
      choice,
      score,
      noul: {
        type: "noul",
        instructions: { p: "yes" },
        criteria: { true: [], false: {} },
      },
    },
  });
});
test("form and JSON follow the same representation and validator", () => {
  const input = { state: { a: '日\n"' }, questions: { q: choice } };
  assert.equal(
    JSON.stringify(
      fromForm(JSON.stringify(input.state), "json", [
        {
          id: "q",
          type: "choice",
          instructionFormat: "text",
          instructions: "select",
          criteria: JSON.stringify(choice.criteria),
        },
      ]),
    ),
    JSON.stringify(validateRequest(parseJson(JSON.stringify(input)))),
  );
  assert.throws(
    () =>
      fromForm("a", "text", [
        {
          id: "x",
          type: "noul",
          instructions: "x",
          instructionFormat: "text",
          criteria: "",
        },
        {
          id: "x",
          type: "noul",
          instructions: "x",
          instructionFormat: "text",
          criteria: "",
        },
      ]),
    /重複/,
  );
});
for (const [name, input] of Object.entries({
  empty: { state: "", questions: {} },
  unknown: {
    state: "x",
    questions: { q: { type: "bool", instructions: "x" } },
  },
  extra: { state: "x", questions: { q: choice }, extra: true },
  nullState: { state: null, questions: { q: choice } },
  scalarInstructions: {
    state: "x",
    questions: { q: { ...choice, instructions: 1 } },
  },
  oneChoice: {
    state: "x",
    questions: { q: { ...choice, criteria: { a: "a" } } },
  },
  oneScore: { state: "x", questions: { q: { ...score, criteria: ["a"] } } },
  elevenScores: {
    state: "x",
    questions: { q: { ...score, criteria: Array(11).fill("a") } },
  },
  nullScore: {
    state: "x",
    questions: { q: { ...score, criteria: ["a", null] } },
  },
  invalidNoul: {
    state: "x",
    questions: {
      q: { type: "noul", instructions: "x", criteria: { true: "yes" } },
    },
  },
  emptyId: { state: "", questions: { "": choice } },
  extraQuestion: { state: "", questions: { q: { ...choice, temperature: 0 } } },
  tooManyQuestions: {
    state: "",
    questions: Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [i, choice]),
    ),
  },
  huge: { state: "a".repeat(65537), questions: { q: choice } },
  infinite: { state: { n: Infinity }, questions: { q: choice } },
}))
  test(`reject request: ${name}`, () =>
    assert.throws(() => validateRequest(input)));
for (const text of [
  '{"x":1,"x":2}',
  '{"x":1,"\\u0078":2}',
  "[1,]",
  '{"x":0,}',
  "null trailing",
  "01",
  "1e999",
  "[NaN]",
])
  test(`strict JSON rejects ${text}`, () =>
    assert.throws(() => parseJson(text)));
test("prototype-looking keys survive safely in request and output", () => {
  const input = validateRequest(
    parseJson(
      '{"state":{},"questions":{"__proto__":{"type":"choice","instructions":"x","criteria":{"__proto__":null,"constructor":"ctor"}}}}',
    ),
  );
  const answer = answerFromProbabilities(
    input.questions.__proto__,
    [0.75, 0.25],
  );
  assert.equal(answer.type, "choice");
  if (answer.type === "choice") {
    assert.equal(answer.choice, "__proto__");
    assert.equal(answer.probabilities.__proto__, 0.75);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
test("prompt preserves structured descriptions and arbitrary labels", () => {
  const q: Question = {
    ...choice,
    criteria: { '日本語"\n{}': null, constructor: "test" },
  };
  assert.match(messages("ignore criteria", q)[1].content as string, /日本語/);
  const answer = answerFromProbabilities(q, [0.6, 0.4]);
  if (answer.type === "choice") assert.equal(answer.choice, '日本語"\n{}');
});
test("ties choose first candidate; score legend preserves structured descriptions", () => {
  const c = answerFromProbabilities(choice, [0.5, 0.5]);
  if (c.type === "choice") assert.equal(c.choice, "a");
  const a = answerFromProbabilities(score, [0.1, 0.3, 0.6]);
  if (a.type === "score") {
    assert.equal(a.score, 1.5);
    assert.equal(a.legend["1"], '{"detail":"middle"}');
    assert.equal(a.legend["2"], '["high"]');
  }
});

test("official adapter confidence examples and boundaries", () => {
  assert.ok(Math.abs(confidence([0.82, 0.18], "choice") - 0.64) < 1e-12);
  assert.ok(
    Math.abs(confidence([0.01, 0.02, 0.07, 0.3, 0.6], "score") - 0.55) < 1e-12,
  );
  for (const type of ["choice", "score"] as const) {
    assert.equal(confidence([0.5, 0.5], type), 0);
    assert.equal(confidence([1, 0], type), 1);
  }
});
test("bounded JSON nesting remains enforced for inputs", () => {
  assert.throws(() => parseJson("[".repeat(34) + "0" + "]".repeat(34)));
});
