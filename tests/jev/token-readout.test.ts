import test from "node:test";
import assert from "node:assert/strict";
import { gguf, response, slots } from "../fixtures/readout";
import {
  parseAnswerTokens,
  readAnswerTokens,
} from "../../src/inference/answer-tokens";
import { tokenReadout } from "../../src/features/jev/token-readout";
import { answerFromProbabilities } from "../../src/features/jev/result-math";
import { evaluate } from "../../src/features/jev/evaluate";
import type { Question } from "../../src/features/jev/types";
const snapshot = {
  model: "test",
  generation: 1,
  load_ms: 0,
  threads: 1,
  context: 4096,
};
const choice: Question = {
  type: "choice",
  instructions: "select",
  criteria: { first: "one", second: "two" },
};
const score: Question = {
  type: "score",
  instructions: "rate",
  criteria: ["low", "middle", "high"],
};
test("GGUF v2/v3 discovers actual IDs, preserves label order, rejects ambiguous or missing tokens", async () => {
  for (const v of [2, 3]) {
    const file = gguf(["xx", "B", "A", "C", "A", "D"], v);
    assert.deepEqual(await readAnswerTokens([file]), [
      { label: "B", token: 1 },
      { label: "C", token: 3 },
      { label: "D", token: 5 },
    ]);
  }
  for (const file of [
    gguf(["A"]),
    gguf(["A", "B"], 1),
    new Blob(["bad"]),
    gguf().slice(0, 80),
  ])
    await assert.rejects(readAnswerTokens([file]));
  assert.throws(() => parseAnswerTokens(new Uint8Array(32).buffer));
});
test("vocabulary reader grows its bounded header window without reading tensors", async () => {
  const prefix = "x".repeat(1024 * 1024 + 10);
  assert.deepEqual(await readAnswerTokens([gguf([prefix, "C", "B"])]), [
    { label: "B", token: 2 },
    { label: "C", token: 1 },
  ]);
});
test("conditional softmax uses logprobs, ignoring generated numeric text and unrelated vocabulary", () => {
  const r = response([0.1, 0.2], "A");
  r.choices[0].message.content = '{"p0":0,"p1":0}';
  r.choices[0].logprobs!.content![0].top_logprobs.push({
    token: "unrelated",
    bytes: null,
    logprob: -0.01,
  });
  const out = tokenReadout(r, slots.slice(0, 2));
  assert.ok(Math.abs(out.probabilities[0] - 1 / 3) < 1e-12);
  assert.ok(Math.abs(out.probabilities[1] - 2 / 3) < 1e-12);
});
test("stable softmax handles equal and extremely small raw probabilities without all-zero repair", () => {
  const r = response();
  const entries = r.choices[0].logprobs!.content![0].top_logprobs;
  entries[0].logprob = -10000;
  entries[1].logprob = -10000;
  assert.deepEqual(
    tokenReadout(r, slots.slice(0, 2)).probabilities,
    [0.5, 0.5],
  );
  entries[1].logprob = -20000;
  assert.deepEqual(tokenReadout(r, slots.slice(0, 2)).probabilities, [1, 0]);
});
test("missing, duplicated, non-finite, positive logprobs and multi-token readouts fail explicitly", () => {
  const corruptions = [
    (r) => {
      r.choices[0].logprobs = null;
    },
    (r) => {
      r.choices[0].logprobs.content = [];
    },
    (r) => {
      r.choices[0].logprobs.content[0].top_logprobs.pop();
    },
    (r) => {
      r.choices[0].logprobs.content[0].top_logprobs.push(
        r.choices[0].logprobs.content[0].top_logprobs[0],
      );
    },
    (r) => {
      r.choices[0].logprobs.content[0].top_logprobs[1].logprob = -Infinity;
    },
    (r) => {
      r.choices[0].logprobs.content[0].top_logprobs[1].logprob = NaN;
    },
    (r) => {
      r.choices[0].logprobs.content[0].top_logprobs[1].logprob = 0.1;
    },
    (r) => {
      r.choices[0].logprobs.content[0].top_logprobs[1].bytes = [65];
    },
    (r) => {
      r.choices[0].logprobs.content[0].token = "<think>";
    },
    (r) => {
      r.usage.completion_tokens = 2;
    },
  ] as ((r: any) => void)[];
  for (const corrupt of corruptions) {
    const r = response();
    corrupt(r);
    assert.throws(() => tokenReadout(r, slots.slice(0, 2)));
  }
});
test("choice argmax, score expectation, noul true/false probability retain output shape", () => {
  assert.deepEqual(answerFromProbabilities(choice, [0.25, 0.75]), {
    type: "choice",
    choice: "second",
    probabilities: { first: 0.25, second: 0.75 },
    confidence: 0.5,
  });
  const result = answerFromProbabilities(score, [0.2, 0.3, 0.5]);
  assert.equal(result.type, "score");
  if (result.type === "score") assert.equal(result.score, 1.3);
  assert.deepEqual(
    answerFromProbabilities(
      { type: "noul", instructions: "condition" },
      [0.7, 0.3],
    ),
    { type: "noul", noul: 0.7 },
  );
  for (const p of [[0, 0], [0.5, 0.6], [NaN, 1], [1]])
    assert.throws(() => answerFromProbabilities(choice, p));
});
test("mixed criteria exports raw logprobs/mapping and logs unchanged runtime response", async () => {
  const inputs = [
    response([0.1, 0.9]),
    response([0.2, 0.3, 0.5]),
    response([0.7, 0.3]),
  ];
  const logged: unknown[][] = [];
  const log = console.log;
  console.log = (...args) => {
    logged.push(args);
  };
  try {
    let calls = 0;
    const out = await evaluate(
      {
        createChatCompletion: async (p) => {
          assert.ok(p.logit_bias);
          return inputs[calls++];
        },
      },
      {
        state: "x",
        questions: {
          choice,
          score,
          noul: { type: "noul", instructions: "yes?" },
        },
      },
      snapshot,
      slots,
    );
    assert.equal(out.diagnostics.readout_method, "candidate_token_logprobs_v1");
    assert.equal(out.diagnostics.llm_calls, 3);
    assert.equal(logged[0][2], inputs[0]);
    assert.equal(logged[1][2], inputs[0].choices[0].message.content);
    assert.equal(out.diagnostics.model_outputs[0].output_tokens, 1);
    assert.equal(
      out.diagnostics.model_outputs[0].candidate_tokens![1].token,
      slots[1].token,
    );
    assert.deepEqual(out.diagnostics.normalizations, []);
  } finally {
    console.log = log;
  }
});
test("insufficient model vocabulary fails before inference, without generated-number fallback", async () => {
  await assert.rejects(
    evaluate(
      {
        createChatCompletion: async () => assert.fail("must not call runtime"),
      },
      { state: "x", questions: { score } },
      snapshot,
      slots.slice(0, 2),
    ),
    /最大2件/,
  );
});
