import { captureKey, captureTab, type CaptureNotice } from "./capture";
import { cancelPageJudge, jobKey, startPageJudge } from "./page-judge";
import { handlePageCommand } from "./commands";
import { pageContent, scopeKey, validateScope } from "./content-scope";
import { readRules } from "./site-rules";

const latest = new Map<number, string>();
async function publishCapture(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) return;
  const id = crypto.randomUUID();
  latest.set(tab.windowId, id);
  let notice: CaptureNotice;
  try {
    notice = { id, capture: await captureTab(tab.id) };
  } catch (error) {
    notice = { id, error: (error as Error).message };
  }
  if (latest.get(tab.windowId) === id)
    await chrome.storage.session.set({ [captureKey(tab.windowId)]: notice });
}
chrome.action.onClicked.addListener((tab) => {
  // Call immediately inside the user gesture; awaiting capture would lose it.
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  void publishCapture(tab).catch(console.error);
});
chrome.windows.onRemoved.addListener((windowId) => {
  latest.delete(windowId);
  void chrome.storage.session.remove(captureKey(windowId));
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
});

chrome.commands.onCommand.addListener((command, tab) => {
  void handlePageCommand(command, tab).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const extensionPage = ["index.html", "panel.html", "jev.html"].some(
    (path) => sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(path),
  );
  if (
    message?.type === "jev-save-content-scope" &&
    sender.tab?.id !== undefined &&
    sender.frameId === 0
  ) {
    const tabId = sender.tab.id;
    void (async () => {
      try {
        const scope = validateScope(message.scope);
        const tab = await chrome.tabs.get(tabId);
        if (tab.url !== message.url || sender.url !== message.url)
          throw new Error("ページが移動しました。範囲を選び直してください。");
        // Validate selectors against the same document before persisting them.
        const [validation] = await chrome.scripting.executeScript({
          target: sender.documentId
            ? { tabId, documentIds: [sender.documentId] }
            : { tabId },
          func: pageContent,
          args: [scope, false, message.url],
        });
        if (!validation?.result)
          throw new Error("本文範囲を確認できませんでした。");
        if ("error" in validation.result)
          throw new Error(validation.result.error);
        if (message.draftKey !== undefined) {
          if (
            typeof message.draftKey !== "string" ||
            !message.draftKey.startsWith("jev-scope-draft:")
          )
            throw new Error("対象の編集情報が正しくありません。");
          const draft = (await chrome.storage.session.get(message.draftKey))[
            message.draftKey
          ];
          if (!draft || draft.tabId !== tabId || draft.url !== message.url)
            throw new Error("対象の編集を開き直してください。");
          await chrome.storage.session.set({
            [message.draftKey]: {
              ...draft,
              scope,
              applied: crypto.randomUUID(),
            },
          });
          reply({ ok: true });
          return;
        }
        // Freeze old URL-wide targets into their rules before changing the draft.
        await readRules();
        if (
          scope.root === null &&
          !scope.exclude.length &&
          !scope.images &&
          !scope.sharedExclude?.length
        )
          await chrome.storage.local.remove(scopeKey(message.url));
        else await chrome.storage.local.set({ [scopeKey(message.url)]: scope });
        reply({ ok: true });
      } catch (e) {
        reply({ error: (e as Error).message });
      }
    })();
    return true;
  }
  if (message?.type === "jev-run-page" && extensionPage) {
    try {
      if (
        !Number.isInteger(message.tabId) ||
        !["auto", "text", "selection"].includes(message.mode)
      )
        throw new Error("判定対象が正しくありません。");
      reply({ jobId: startPageJudge(message.tabId, message.mode) });
    } catch (e) {
      reply({ error: (e as Error).message });
    }
  }
  if (message?.type === "jev-cancel-page" && extensionPage) {
    cancelPageJudge(message.tabId, message.jobId);
    reply({ ok: true });
  }
  if (message?.type === "jev-overlay-cancel" && sender.tab?.id !== undefined) {
    cancelPageJudge(sender.tab.id, message.jobId);
    reply({ ok: true });
  }
  if (message?.type === "jev-open-management" && sender.tab?.id !== undefined) {
    void chrome.tabs.create({ url: chrome.runtime.getURL("index.html#sites") });
    reply({ ok: true });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  cancelPageJudge(tabId);
  void chrome.storage.session.remove(jobKey(tabId));
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url) cancelPageJudge(tabId);
});
