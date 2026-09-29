import test from "node:test";
import assert from "node:assert/strict";
import {
  JUDGE_CHANNEL,
  ManagerBridge,
  type JudgeMessage,
  type WebRequest,
  type WebResult,
} from "../../src/extension/judge-channel";

Object.assign(globalThis, {
  chrome: { tabs: { getCurrent: async () => ({ id: 42 }) } },
});
const result = {
  input: { state: "page", questions: {} },
  presentation: {},
  evaluation: {},
} as WebResult;
function waitFor(
  channel: BroadcastChannel,
  predicate: (m: JudgeMessage) => boolean,
) {
  return new Promise<JudgeMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.removeEventListener("message", listener);
      reject(new Error("channel timeout"));
    }, 2000);
    const listener = (event: MessageEvent<JudgeMessage>) => {
      if (predicate(event.data)) {
        clearTimeout(timer);
        channel.removeEventListener("message", listener);
        resolve(event.data);
      }
    };
    channel.addEventListener("message", listener);
  });
}
test("management bridge serializes shared inference and rejects another client's cancellation", async (t) => {
  const channel = new BroadcastChannel(JUDGE_CHANNEL);
  let complete!: (r: WebResult) => void;
  let signal!: AbortSignal;
  let cancelCount = 0;
  const bridge = new ManagerBridge({
    status: () => ({ ready: true, model: "local", phase: "ready" }),
    evaluate: async (_request, abort) => {
      signal = abort;
      return new Promise<WebResult>((resolve) => {
        complete = resolve;
      });
    },
    cancel: async () => {
      cancelCount++;
    },
    manage: () => {},
  });
  t.after(() => {
    bridge.close();
    channel.close();
  });
  const request: WebRequest = {
    requestId: "first",
    clientId: "panel1",
    managerId: bridge.id,
    ruleId: "rule",
    url: "https://example.com",
    text: "page",
  };
  const busy = waitFor(channel, (m) => m.type === "status" && !m.status.ready);
  channel.postMessage({ type: "evaluate", request });
  await busy;
  const rejected = waitFor(
    channel,
    (m) => m.type === "result" && m.requestId === "second",
  );
  channel.postMessage({ type: "cancel", ...request, clientId: "panel2" });
  channel.postMessage({
    type: "evaluate",
    request: { ...request, requestId: "second", clientId: "panel2" },
  });
  const reply = await rejected;
  assert.equal(reply.type, "result");
  if (reply.type === "result") assert.match(reply.error!, /実行中/);
  assert.equal(cancelCount, 0);
  assert.equal(signal.aborted, false);
  const finished = waitFor(
    channel,
    (m) => m.type === "result" && m.requestId === "first",
  );
  complete(result);
  const final = await finished;
  if (final.type === "result") {
    assert.equal(final.clientId, "panel1");
    assert.deepEqual(final.result, result);
  }
});
test("owned cancellation aborts pending preparation and restores readiness", async (t) => {
  const channel = new BroadcastChannel(JUDGE_CHANNEL);
  let cancelCount = 0;
  const bridge = new ManagerBridge({
    status: () => ({ ready: true, model: "local", phase: "ready" }),
    evaluate: async (_request, signal) =>
      new Promise<WebResult>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      ),
    cancel: async () => {
      cancelCount++;
    },
    manage: () => {},
  });
  t.after(() => {
    bridge.close();
    channel.close();
  });
  const request: WebRequest = {
    requestId: "cancel-me",
    clientId: "panel",
    managerId: bridge.id,
    ruleId: "rule",
    url: "https://example.com",
    text: "page",
  };
  const busy = waitFor(channel, (m) => m.type === "status" && !m.status.ready);
  channel.postMessage({ type: "evaluate", request });
  await busy;
  const cancelled = waitFor(
    channel,
    (m) => m.type === "result" && m.requestId === request.requestId,
  );
  const ready = waitFor(channel, (m) => m.type === "status" && m.status.ready);
  channel.postMessage({ type: "cancel", ...request });
  const message = await cancelled;
  if (message.type === "result") assert.equal(message.error, "cancelled");
  await ready;
  assert.equal(cancelCount, 1);
});
