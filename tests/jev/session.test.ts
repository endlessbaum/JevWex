import { gguf, response, slots } from "../fixtures/readout";
import test from "node:test";
import assert from "node:assert/strict";
import type {
  ChatCompletionParams,
  ChatCompletionResponse,
} from "@wllama/wllama";
import { evaluate } from "../../src/features/jev/evaluate";
import { ModelSession, type Runtime } from "../../src/inference/model-session";
import { asJevError, type JevInput } from "../../src/features/jev/types";
import { RequestState } from "../../src/pages/jev/request-state";
const input: JevInput = {
  state: "a",
  questions: { question: { type: "noul", instructions: "x" } },
};
const result = (text = "A", finish = "length") =>
  response([0.8, 0.2], text, finish);
const snapshot = {
  model: "local:a",
  generation: 1,
  load_ms: 10,
  threads: 1,
  context: 4096,
};
function fixture() {
  const events: string[] = [];
  let handler = async (_: ChatCompletionParams) => result();
  const factory = () =>
    ({
      loadModel: async () => {
        events.push("load");
      },
      exit: async () => {
        events.push("exit");
      },
      getChatTemplate: () => "metadata template",
      getNumThreads: () => 1,
      getLoadedContextInfo: () => ({ n_ctx: 4096 }),
      createChatCompletion: (p: ChatCompletionParams) => handler(p),
    }) as Runtime;
  const session = new ModelSession(factory);
  for (const id of ["local:a", "local:b"])
    session.register({ id, label: id, size: 1, source: [gguf()] });
  return {
    session,
    events,
    setHandler: (fn: typeof handler) => {
      handler = fn;
    },
  };
}
test("adapter isolates questions and reads token probabilities without JSON generation", async () => {
  const requests: ChatCompletionParams[] = [];
  const out = await evaluate(
    {
      createChatCompletion: async (p) => {
        requests.push(p);
        return result();
      },
    },
    {
      state: "abc",
      questions: {
        unique_question_id: input.questions.question,
        second: input.questions.question,
      },
    },
    snapshot,
    slots,
  );
  assert.equal(out.diagnostics.llm_calls, 2);
  assert.equal(requests.length, 2);
  assert.equal(
    JSON.stringify(requests[0].messages).includes("unique_question_id"),
    false,
  );
  assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.equal(requests[0].response_format, undefined);
  assert.equal(requests[0].max_tokens, 1);
  assert.equal(requests[0].logprobs, true);
  assert.equal(requests[0].temperature, 1);
  assert.deepEqual(requests[0].chat_template_kwargs, {
    enable_thinking: false,
  });
  assert.equal(requests[0].grammar, 'root ::= "A" | "B"');
  assert.equal(requests[0].cache_prompt, false);
});
test("output limit, invalid output and partial failure never return success", async () => {
  for (const r of [
    result("{", "stop"),
    result('{"noul":0.8}', "length"),
    result('{"noul":0.8}', null as unknown as string),
  ])
    await assert.rejects(
      evaluate({ createChatCompletion: async () => r }, input, snapshot, slots),
    );
  let calls = 0;
  await assert.rejects(
    evaluate(
      {
        createChatCompletion: async () =>
          ++calls === 1 ? result() : result("broken"),
      },
      {
        state: "a",
        questions: {
          one: input.questions.question,
          two: input.questions.question,
        },
      },
      snapshot,
      slots,
    ),
    (e: unknown) => {
      assert.equal((e as { question: string }).question, "two");
      return true;
    },
  );
});
test("model IDs resolve explicitly; UI selection does not replace loaded model", async () => {
  const { session } = fixture();
  await session.load("local:a");
  session.selected = "local:b";
  assert.equal((await session.evaluate(input)).response.model, "local:a");
  assert.throws(
    () => session.resolveModel({ ...input, model: "jev-latest" }),
    /未登録/,
  );
  assert.throws(
    () => session.resolveModel({ ...input, model: "local:b" }),
    /未読込/,
  );
  await session.load("local:b");
  assert.equal((await session.evaluate(input)).response.model, "local:b");
});
test("cancel, switch, repeated clicks and retry await cancellation before exit", async () => {
  const { session, events, setHandler } = fixture();
  await session.load("local:a");
  setHandler(
    (p) =>
      new Promise((_, reject) =>
        p.abortSignal!.addEventListener(
          "abort",
          () => {
            events.push("abort");
            setTimeout(() => {
              events.push("ack");
              reject(new DOMException("cancelled", "AbortError"));
            }, 5);
          },
          { once: true },
        ),
      ),
  );
  const run = session.evaluate(input);
  const rejected = assert.rejects(run, /cancel|中止/);
  await assert.rejects(session.evaluate(input), /実行中/);
  const switching = session.load("local:b");
  await assert.rejects(session.load("local:a"), /モデル操作中/);
  await switching;
  await rejected;
  assert.deepEqual(events, ["load", "abort", "ack", "exit", "load"]);
  setHandler(async () => result());
  assert.equal((await session.evaluate(input)).response.model, "local:b");
  await session.unload();
  assert.equal(session.loaded, null);
});
test("upstream signal reaches public API and stale completion cannot succeed", async () => {
  const { session, setHandler } = fixture();
  await session.load("local:a");
  const controller = new AbortController();
  setHandler(
    (p) =>
      new Promise((resolve) =>
        p.abortSignal!.addEventListener("abort", () => resolve(result())),
      ),
  );
  const run = session.evaluate(input, controller.signal);
  controller.abort();
  await assert.rejects(run, /中止/);
});
test("failed inference permits an explicit retry without reloading", async () => {
  const { session, events, setHandler } = fixture();
  await session.load("local:a");
  setHandler(async () => result("bad"));
  await assert.rejects(session.evaluate(input));
  setHandler(async () => result());
  await session.evaluate(input);
  assert.deepEqual(events, ["load"]);
});
test("missing template and failed load release resources; another load works", async () => {
  let good = false,
    exits = 0;
  const session = new ModelSession(() => ({
    loadModel: async () => {},
    exit: async () => {
      exits++;
    },
    getChatTemplate: () => (good ? "template" : null),
    getNumThreads: () => 1,
    getLoadedContextInfo: () => ({ n_ctx: 4096 }),
    createChatCompletion: async () => result(),
  }));
  session.register({
    id: "local:a",
    label: "a",
    size: 1,
    source: [gguf()],
  });
  await assert.rejects(session.load(), /テンプレート/);
  assert.equal(exits, 1);
  assert.equal(session.loaded, null);
  good = true;
  await session.load();
  assert.ok(session.loaded);
});
test("resolved native load failure reports initialization logs, not a missing template", async () => {
  let good = false;
  let exits = 0;
  let templateReads = 0;
  const session = new ModelSession((onLog) => ({
    loadModel: async () => {
      if (!good) {
        onLog?.("loading model");
        onLog?.("ggml_backend: failed to allocate buffer");
        onLog?.("failed to load model");
      }
    },
    exit: async () => {
      exits++;
    },
    getChatTemplate: () => {
      templateReads++;
      return good ? "template" : null;
    },
    getNumThreads: () => 1,
    getLoadedContextInfo: () => ({ n_ctx: good ? 4096 : 0 }),
    createChatCompletion: async () => result(),
  }));
  session.register({ id: "local:a", label: "a", size: 1, source: [gguf()] });
  await assert.rejects(session.load(), (error: unknown) => {
    assert.equal(asJevError(error).code, "LOAD_FAILED");
    assert.match(asJevError(error).message, /初期化に失敗/);
    assert.match(asJevError(error).message, /failed to allocate buffer/);
    assert.doesNotMatch(asJevError(error).message, /テンプレート/);
    return true;
  });
  assert.equal(templateReads, 0);
  assert.equal(exits, 1);
  assert.equal(session.loaded, null);
  assert.equal(session.phase, "error");
  good = true;
  await session.load();
  assert.equal(session.phase, "ready");
});

test("extended response deadline survives four minutes and cancels at the configured time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, setHandler } = fixture();
  await session.load("local:a");
  session.timeouts = { loadSeconds: 900, responseSeconds: 600 };
  let aborted = false;
  setHandler(
    (p) =>
      new Promise((resolve) =>
        p.abortSignal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve(result());
          },
          { once: true },
        ),
      ),
  );
  const run = session.evaluate(input);
  const rejected = assert.rejects(run, (e: unknown) => {
    assert.equal(asJevError(e).code, "TIMEOUT");
    assert.match(asJevError(e).message, /600秒/);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(240000);
  assert.equal(aborted, false);
  // Saving new preferences must not shorten an already running operation.
  session.timeouts.responseSeconds = 1;
  t.mock.timers.tick(360000);
  await rejected;
  assert.equal(aborted, true);
  assert.equal(session.phase, "ready");
  setHandler(async () => result());
  await session.evaluate(input);
});

test("load timeout uses the configured limit and releases the failed runtime", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let exits = 0;
  const session = new ModelSession(() => ({
    loadModel: () => new Promise(() => {}),
    exit: async () => {
      exits++;
    },
    getChatTemplate: () => "template",
    getNumThreads: () => 1,
    getLoadedContextInfo: () => ({ n_ctx: 4096 }),
    createChatCompletion: async () => result(),
  }));
  session.register({ id: "local:a", label: "a", size: 1, source: [gguf()] });
  session.timeouts.loadSeconds = 600;
  const load = session.load();
  const rejected = assert.rejects(load, /600秒/);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(180000);
  assert.equal(session.phase, "loading");
  t.mock.timers.tick(420000);
  await rejected;
  assert.equal(exits, 1);
  assert.equal(session.phase, "error");
});

test("UI request tickets discard edits, cancellation and late results", () => {
  const state = new RequestState(),
    a = state.begin();
  assert.ok(state.accepts(a));
  state.edit();
  assert.equal(state.accepts(a), false);
  const b = state.begin();
  state.cancel();
  assert.equal(state.accepts(b), false);
  const c = state.begin(),
    d = state.begin();
  assert.equal(state.accepts(c), false);
  assert.ok(state.accepts(d));
});
test("input snapshot survives mutation while awaiting the runtime", async () => {
  const mutable = structuredClone(input);
  const out = await evaluate(
    {
      createChatCompletion: async () => {
        mutable.questions.question = {
          type: "choice",
          instructions: "changed",
          criteria: { a: null, b: null },
        };
        return result();
      },
    },
    mutable,
    snapshot,
    slots,
  );
  assert.equal(out.response.answers.question.type, "noul");
});
test("runtime context and template errors have actionable codes", () => {
  assert.equal(
    asJevError(new Error("input exceeds context size")).code,
    "CONTEXT_LIMIT",
  );
  assert.equal(
    asJevError(new Error("failed to apply chat template")).code,
    "MODEL_UNSUPPORTED",
  );
});

test("adding a projector under the same model id reloads the registered source", async () => {
  const f = fixture();
  await f.session.load("local:a");
  const first = f.session.loaded!.generation;
  await f.session.load("local:a");
  assert.equal(f.session.loaded!.generation, first);
  f.session.register({
    id: "local:a",
    label: "with projector",
    size: 2,
    source: [gguf(), new Blob(["projector"])],
  });
  await f.session.load("local:a");
  assert.ok(f.session.loaded!.generation > first);
  assert.deepEqual(f.events, ["load", "exit", "load"]);
});
