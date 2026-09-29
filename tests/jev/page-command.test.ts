import test from "node:test";
import assert from "node:assert/strict";
import { handlePageCommand } from "../../src/extension/commands";

test("shortcut starts the supplied tab without querying or opening the side panel", async () => {
  // No sidePanel API in this mock: the handler must not depend on it.
  Object.assign(globalThis, {
    chrome: {
      tabs: {
        query: () => {
          throw new Error("unexpected query");
        },
      },
    },
  });
  const calls: number[] = [];
  const start = (id: number) => {
    calls.push(id);
    return "job";
  };
  await handlePageCommand("different-command", undefined, start);
  await handlePageCommand("evaluate-page", { id: 9 } as chrome.tabs.Tab, start);
  assert.deepEqual(calls, [9]);
});
test("shortcut resolves the active tab when Chrome omits it and reports an already-running job", async () => {
  const titles: unknown[] = [];
  Object.assign(globalThis, {
    chrome: {
      tabs: {
        query: async (query: unknown) => {
          assert.deepEqual(query, { active: true, currentWindow: true });
          return [{ id: 12 }];
        },
      },
      action: {
        setTitle: async (value: unknown) => {
          titles.push(value);
        },
      },
    },
  });
  await handlePageCommand("evaluate-page", undefined, (id) => {
    assert.equal(id, 12);
    throw new Error("already running");
  });
  assert.deepEqual(titles, [{ tabId: 12, title: "already running" }]);
});
