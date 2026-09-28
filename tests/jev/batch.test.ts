import test from "node:test";
import assert from "node:assert/strict";
import {
  lineItems,
  parseTable,
  tableItems,
  newBatch,
  runBatch,
  summarizeBatch,
  toCsv,
  MAX_BATCH_BYTES,
} from "../../src/features/jev/batch";
import {
  JevError,
  type LocalEvaluation,
  type JevInput,
} from "../../src/features/jev/types";
const model = {
  model: "local:test",
  generation: 1,
  threads: 1,
  context: 4096,
  load_ms: 1,
};
const questions: JevInput["questions"] = {
  choice: {
    type: "choice",
    instructions: "choose",
    criteria: { a: "A", b: "B" },
  },
  score: { type: "score", instructions: "rate", criteria: ["low", "high"] },
  noul: { type: "noul", instructions: "fits" },
};
function output(value = 0.2): LocalEvaluation {
  return {
    response: {
      model: model.model,
      answers: {
        choice: {
          type: "choice",
          choice: value < 0.5 ? "a" : "b",
          probabilities: { a: 1 - value, b: value },
          confidence: 0.6,
        },
        score: {
          type: "score",
          score: value,
          probabilities: { "0": 1 - value, "1": value },
          confidence: 0.6,
          legend: { "0": "low", "1": "high" },
        },
        noul: { type: "noul", noul: value },
      },
    },
    diagnostics: {
      ...model,
      runtime: "wllama extension page",
      wllama_version: "3.6.1",
      evaluation_ms: 1,
      question_count: 3,
      llm_calls: 3,
      format_validated: true,
      confidence_method: "typesafe_adapter_e1d4cc9",
      warnings: [],
      model_outputs: [],
      normalizations: [],
    },
  };
}
test("CSV supports BOM, quoted commas/newlines/quotes, CRLF and TSV paste", () => {
  const rows = parseTable(
    '\uFEFF名前,内容\r\n一,"文,章\n複数行"\r\n二,"say ""hello"""\r\n',
  );
  assert.deepEqual(rows, [
    ["名前", "内容"],
    ["一", "文,章\n複数行"],
    ["二", 'say "hello"'],
  ]);
  assert.equal(tableItems(rows, true, 1, 0)[0].text, "文,章\n複数行");
  assert.deepEqual(parseTable('名前\t内容\n一\t"A\tB"'), [
    ["名前", "内容"],
    ["一", "A\tB"],
  ]);
  assert.equal(tableItems([["A", "B"]], false, -1)[0].text, "列1：A\n列2：B");
  assert.equal(
    tableItems(
      [
        ["名前", "内容"],
        ["同名", "x"],
        ["同名", "y"],
      ],
      true,
      1,
      0,
    )[1].number,
    2,
  );
});
test("empty rows, blank selected cells, malformed CSV and import limits are explicit", () => {
  assert.deepEqual(
    lineItems("first\r\n\nsecond").map((x) => x.text),
    ["first", "second"],
  );
  assert.equal(
    tableItems(parseTable("name,text\nrow1,\n\n"), true, 1)[0].text,
    "",
  );
  for (const source of ["a,b\nx", 'a,"unfinished', '"a"x,b', 'a"b,c'])
    assert.throws(() => parseTable(source));
  assert.throws(() => lineItems("x".repeat(MAX_BATCH_BYTES + 1)));
  assert.equal(lineItems(Array(10000).fill("row").join("\n")).length, 10000);
  assert.throws(() => lineItems(Array(10001).fill("row").join("\n")));
  assert.throws(() => newBatch([], questions, model));
});
test("batch freezes criteria/content, runs sequentially, isolates row errors and resumes only unfinished rows", async () => {
  const items = lineItems("first\nsecond\nthird"),
    criteria = structuredClone(questions);
  const report = newBatch(items, criteria, model);
  items[0].text = "mutated";
  criteria.noul.instructions = "mutated";
  let active = 0,
    maxActive = 0;
  const seen: string[] = [];
  await runBatch(
    report,
    async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      seen.push(String(input.state));
      await Promise.resolve();
      active--;
      assert.equal(input.questions.noul.instructions, "fits");
      if (input.state === "second")
        throw new JevError("INVALID_OUTPUT", "bad output");
      return output();
    },
    new AbortController().signal,
    () => {},
  );
  assert.equal(maxActive, 1);
  assert.deepEqual(seen, ["first", "second", "third"]);
  assert.deepEqual(
    report.rows.map((r) => r.status),
    ["success", "error", "success"],
  );
  seen.length = 0;
  await runBatch(
    report,
    async (input) => {
      seen.push(String(input.state));
      return output();
    },
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(seen, ["second"]);
  assert.equal(summarizeBatch(report).totals.success, 3);
});
test("cancel keeps successful results and unprocessed rows; fatal runtime errors stop the queue", async () => {
  const report = newBatch(lineItems("one\ntwo\nthree"), questions, model),
    controller = new AbortController();
  await runBatch(
    report,
    async (input) => {
      if (input.state === "two") {
        controller.abort();
        throw new DOMException("cancel", "AbortError");
      }
      return output();
    },
    controller.signal,
    () => {},
  );
  assert.deepEqual(
    report.rows.map((r) => r.status),
    ["success", "cancelled", "pending"],
  );
  assert.equal(summarizeBatch(report).criteria.score.count, 1);
  await runBatch(
    report,
    async () => {
      throw new JevError("RUNTIME_UNAVAILABLE", "worker stopped");
    },
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(
    report.rows.map((r) => r.status),
    ["success", "error", "pending"],
  );
});
test("empty text fails per row; image-only input receives the corresponding image record", async () => {
  const report = newBatch(
    [
      { number: 1, name: "empty", text: "" },
      {
        number: 2,
        name: "pic",
        text: "",
        image: { name: "a.png", type: "image/png", size: 5 },
      },
    ],
    questions,
    model,
  );
  await runBatch(
    report,
    async (input, _signal, row) => {
      assert.equal(input.state, "添付画像を判定してください。");
      assert.equal(row.image?.name, "a.png");
      return output();
    },
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(
    report.rows.map((r) => r.status),
    ["error", "success"],
  );
});
test("all summary denominators exclude failed and unprocessed rows; scores remain continuous", async () => {
  const report = newBatch(lineItems("one\ntwo\nthree\nfour"), questions, model);
  report.rows[0].status = report.rows[1].status = "success";
  report.rows[0].result = output(0.2);
  report.rows[1].result = output(0.7);
  report.rows[2].status = "error";
  const s = summarizeBatch(report);
  assert.deepEqual(s.totals, {
    total: 4,
    success: 2,
    error: 1,
    cancelled: 0,
    pending: 1,
    running: 0,
  });
  assert.deepEqual(s.criteria.choice.counts, { a: 1, b: 1 });
  assert.ok(Math.abs(s.criteria.score.mean! - 0.45) < 1e-12);
  assert.equal(s.criteria.score.min, 0.2);
  assert.equal(s.criteria.score.max, 0.7);
  assert.ok(Math.abs(s.criteria.score.meanWeights["0"] - 0.55) < 1e-12);
  assert.equal(s.criteria.noul.atLeastHalf, 1);
  assert.equal(
    summarizeBatch(newBatch(lineItems("x"), questions, model)).criteria.score
      .mean,
    null,
  );
});
test("CSV export preserves multiline cells and neutralizes spreadsheet formulas", () => {
  const csv = toCsv([
    ["name", "value"],
    ["=SUM(1,2)", 0.5],
    ["\t@cmd", 'a\n"b"'],
  ]);
  assert.ok(csv.startsWith("\uFEFF"));
  const rows = parseTable(csv);
  assert.equal(rows[1][0], "'=SUM(1,2)");
  assert.equal(rows[1][1], "0.5");
  assert.equal(rows[2][0], "'\t@cmd");
  assert.equal(rows[2][1], 'a\n"b"');
});
