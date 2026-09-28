import { gguf, response } from "../fixtures/readout";
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HARDWARE,
  DEFAULT_LOAD,
  readHardware,
  resolveHardware,
  validateHardware,
  sameHardware,
  type HardwareCapabilities,
} from "../../src/inference/hardware";
import { ModelSession, type Runtime } from "../../src/inference/model-session";
import type { LoadModelParams } from "@wllama/wllama";
const caps: HardwareCapabilities = {
  cores: 16,
  multiThread: true,
  gpu: true,
  gpuName: "test",
  gpuReason: "",
};
test("hardware auto threads respects capability and limits; GPU must be requested", () => {
  assert.deepEqual(resolveHardware(DEFAULT_HARDWARE, caps), {
    device: "cpu",
    threads: 8,
    gpuLayers: 0,
    context: 4096,
  });
  assert.equal(
    resolveHardware(DEFAULT_HARDWARE, { ...caps, cores: 6 }).threads,
    3,
  );
  assert.equal(
    resolveHardware(DEFAULT_HARDWARE, { ...caps, multiThread: false }).threads,
    1,
  );
  assert.equal(
    resolveHardware({ ...DEFAULT_HARDWARE, device: "webgpu" }, caps).gpuLayers,
    99999,
  );
  assert.equal(
    resolveHardware(
      { ...DEFAULT_HARDWARE, device: "webgpu", gpuLayers: 4 },
      caps,
    ).gpuLayers,
    4,
  );
  assert.throws(
    () =>
      resolveHardware(
        { ...DEFAULT_HARDWARE, device: "webgpu" },
        { ...caps, gpu: false },
      ),
    /GPUを利用できません/,
  );
  assert.throws(
    () =>
      resolveHardware(
        { ...DEFAULT_HARDWARE, threads: 2 },
        { ...caps, multiThread: false },
      ),
    /複数CPU/,
  );
  assert.throws(
    () => resolveHardware({ ...DEFAULT_HARDWARE, threads: 32 }, caps),
    /16以下/,
  );
});
test("invalid or old stored settings fall back to defaults", () => {
  for (const raw of [null, "{", "{}", '{"device":"cpu","threads":0}'])
    assert.deepEqual(readHardware({ getItem: () => raw }), DEFAULT_HARDWARE);
  assert.deepEqual(
    readHardware({
      getItem: () => {
        throw new Error("blocked");
      },
    }),
    DEFAULT_HARDWARE,
  );
  assert.deepEqual(
    readHardware({
      getItem: () => JSON.stringify({ ...DEFAULT_HARDWARE, threads: 4 }),
    }),
    { ...DEFAULT_HARDWARE, threads: 4 },
  );
  for (const changed of [
    { threads: 1.5 },
    { threads: 0 },
    { threads: Infinity },
    { context: -1 },
    { gpuLayers: 0 },
    { device: "cuda" },
  ])
    assert.throws(() => validateHardware({ ...DEFAULT_HARDWARE, ...changed }));
});
test("hardware changes reload the same model and capture actual threads and public GPU logs", async () => {
  let params: LoadModelParams = {};
  const events: string[] = [];
  const session = new ModelSession(
    (onLog) =>
      ({
        loadModel: async (_source, p) => {
          params = p!;
          events.push("load");
          if (p!.n_gpu_layers)
            onLog?.("load_tensors: offloaded 4/25 layers to GPU");
        },
        exit: async () => {
          events.push("exit");
        },
        getChatTemplate: () => "template",
        getNumThreads: () => params.n_threads!,
        getLoadedContextInfo: () => ({ n_ctx: params.n_ctx! }),
        createChatCompletion: async () => {
          throw new Error("not used");
        },
      }) as Runtime,
  );
  session.register({ id: "a", label: "a", size: 1, source: [gguf()] });
  await session.load("a", DEFAULT_LOAD);
  await session.load("a", { ...DEFAULT_LOAD });
  assert.deepEqual(events, ["load"]);
  const gpu = {
    ...DEFAULT_LOAD,
    device: "webgpu" as const,
    threads: 4,
    gpuLayers: 4,
    context: 2048,
  };
  await session.load("a", gpu);
  assert.deepEqual(events, ["load", "exit", "load"]);
  assert.equal(params.n_threads, 4);
  assert.equal(params.n_gpu_layers, 4);
  assert.equal(params.n_ctx, 2048);
  assert.equal(params.ctx_shift, false);
  assert.equal(params.n_parallel, 1);
  assert.equal(session.loaded!.threads, 4);
  assert.equal(session.loaded!.hardware!.gpu_layers_offloaded, 4);
  assert.ok(sameHardware(session.loaded!.hardware!.requested, gpu));
});
