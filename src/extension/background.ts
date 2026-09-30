import { captureKey, captureTab, type CaptureNotice } from "./capture";
import { cancelPageJudge, jobKey, startPageJudge } from "./page-judge";
import { handlePageCommand } from "./commands";
import { pageContent, scopeKey, validateScope } from "./content-scope";
import { readRules } from "./site-rules";
import { linkCharacterLimit, linkInput, loadLinkExcerpts } from "./page-links";
import { readManagerInputContext } from "./judge-channel";
import { CloudKeyStore, isCloudSettingsSender } from "./cloud-key-store";
import { JevError } from "../features/jev/types";

const cloudKeys = new CloudKeyStore(chrome.storage.local, (endpoint) =>
  chrome.permissions.contains({
    origins: [`${new URL(endpoint).protocol}//${new URL(endpoint).hostname}/*`],
  }),
);
const cloudRequests = new Map<
  string,
  {
    owner: string;
    tabId?: number;
    profileId?: string;
    controller: AbortController;
  }
>();
function cancelCloudRequests(tabId?: number) {
  for (const request of cloudRequests.values())
    if (tabId === undefined || request.tabId === tabId)
      request.controller.abort();
}
function cancelCloudProfileRequests(profileId?: string) {
  for (const request of cloudRequests.values())
    if (profileId === undefined || request.profileId === profileId)
      request.controller.abort();
}

const linkPreviews = new Map<
  string,
  { tabId: number; controller: AbortController }
>();
function cancelLinkPreviews(tabId: number, requestId?: string) {
  for (const [id, preview] of linkPreviews)
    if (preview.tabId === tabId && (!requestId || id === requestId)) {
      preview.controller.abort();
      linkPreviews.delete(id);
    }
}

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
  if (
    typeof message?.type === "string" &&
    message.type.startsWith("jev-cloud-")
  ) {
    if (
      !isCloudSettingsSender(sender, chrome.runtime.id, chrome.runtime.getURL)
    ) {
      reply({
        ok: false,
        code: "INVALID_REQUEST",
        error: "API設定・通信はモデル管理画面から操作してください。",
      });
      return;
    }
    const owner = sender.documentId ?? `${sender.tab?.id ?? ""}:${sender.url}`;
    void (async () => {
      let requestId: string | undefined;
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      try {
        let result;
        switch (message.type) {
          case "jev-cloud-status":
            result = await cloudKeys.status(message.profileId);
            break;
          case "jev-cloud-save":
            cancelCloudProfileRequests(message.profileId);
            result = await cloudKeys.save(
              message.settings,
              message.apiKey,
              message.profileId,
              message.name,
            );
            break;
          case "jev-cloud-delete":
            cancelCloudProfileRequests(message.profileId);
            result = await cloudKeys.remove(message.profileId);
            break;
          case "jev-cloud-cancel": {
            const current = cloudRequests.get(message.requestId);
            if (current?.owner === owner) current.controller.abort();
            result = null;
            break;
          }
          case "jev-cloud-evaluate": {
            if (
              typeof message.requestId !== "string" ||
              !/^[\w-]{1,80}$/.test(message.requestId) ||
              cloudRequests.has(message.requestId)
            )
              throw new JevError(
                "INVALID_REQUEST",
                "APIリクエストの識別情報が正しくありません。",
              );
            requestId = message.requestId;
            const controller = new AbortController();
            cloudRequests.set(requestId!, {
              owner,
              tabId: sender.tab?.id,
              profileId: message.profileId,
              controller,
            });
            keepAlive = setInterval(() => {
              void chrome.runtime.getPlatformInfo().catch(() => {});
            }, 15000);
            result = await cloudKeys.evaluate(
              message.input,
              message.settings,
              controller.signal,
              message.profileId,
            );
            break;
          }
          default:
            throw new JevError(
              "INVALID_REQUEST",
              "API操作が正しくありません。",
            );
        }
        reply({ ok: true, value: result });
      } catch (error) {
        const aborted =
          requestId && cloudRequests.get(requestId)?.controller.signal.aborted;
        reply({
          ok: false,
          code: aborted
            ? "CANCELLED"
            : error instanceof JevError
              ? error.code
              : "API_ERROR",
          error: aborted
            ? "中止しました"
            : error instanceof JevError
              ? error.message
              : "API設定・通信の処理に失敗しました。",
        });
      } finally {
        if (requestId) cloudRequests.delete(requestId);
        clearInterval(keepAlive);
      }
    })();
    return true;
  }
  const extensionPage = ["index.html", "panel.html", "jev.html"].some(
    (path) => sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(path),
  );
  if (
    message?.type === "jev-preview-link-scope" &&
    (extensionPage || (sender.tab?.id !== undefined && sender.frameId === 0))
  ) {
    const tabId = extensionPage ? message.tabId : sender.tab!.id!;
    void (async () => {
      const requestId = message.requestId;
      try {
        if (
          !Number.isInteger(tabId) ||
          typeof requestId !== "string" ||
          !/^[\w-]{1,80}$/.test(requestId) ||
          typeof message.url !== "string"
        )
          throw new Error("リンク先のプレビュー対象が正しくありません。");
        const scope = validateScope(message.scope);
        if (!scope.linkedPages)
          throw new Error("リンク先の判定をオンにしてください。");
        if (!extensionPage && sender.url !== message.url)
          throw new Error("ページが移動しました。対象を選び直してください。");
        cancelLinkPreviews(tabId);
        const controller = new AbortController();
        linkPreviews.set(requestId, { tabId, controller });
        const capture = await captureTab(tabId, scope);
        if (
          capture.url !== message.url ||
          (sender.documentId &&
            !extensionPage &&
            capture.documentId !== sender.documentId)
        )
          throw new Error("ページが移動しました。対象を選び直してください。");
        // Derive URLs again from the actual selected DOM, never accept a generic
        // cross-origin fetch URL from a content-script message.
        const links = [
          ...new Map(
            (capture.items
              ? capture.items.flatMap((item) => item.links ?? [])
              : (capture.links ?? [])
            ).map((link) => [link.url, link]),
          ).values(),
        ].slice(0, 4);
        if (!links.length)
          throw new Error("対象に取得可能なリンクがありません。");
        const previews: string[] = [];
        const characterLimit = linkCharacterLimit(
          await readManagerInputContext(),
        );
        for (const link of links) {
          controller.signal.throwIfAborted();
          try {
            const excerpts = await loadLinkExcerpts(
              capture,
              [link],
              controller.signal,
              characterLimit,
            );
            previews.push(
              `${link.label}\nURL：${link.url}\nページタイトル：${excerpts[0].title}\n${linkInput(excerpts, characterLimit)}`,
            );
          } catch (error) {
            controller.signal.throwIfAborted();
            previews.push(
              `${link.label}\n${link.url}\n${(error as Error).message}`,
            );
          }
        }
        controller.signal.throwIfAborted();
        reply({
          text: `本文の入力上限：${characterLimit.toLocaleString()}文字（モデルの上限の80%・複数リンクは判定時に合計で調整）\n\n${previews.join("\n\n")}`,
        });
      } catch (error) {
        reply({ error: (error as Error).message });
      } finally {
        if (linkPreviews.get(requestId)?.tabId === tabId)
          linkPreviews.delete(requestId);
      }
    })();
    return true;
  }
  if (
    message?.type === "jev-cancel-link-preview" &&
    (extensionPage || sender.frameId === 0)
  ) {
    const preview = linkPreviews.get(message.requestId);
    if (preview && (extensionPage || preview.tabId === sender.tab?.id))
      cancelLinkPreviews(preview.tabId, message.requestId);
    reply({ ok: true });
  }
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
          !scope.linkedPages &&
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
  cancelCloudRequests(tabId);
  cancelLinkPreviews(tabId);
  cancelPageJudge(tabId);
  void chrome.storage.session.remove(jobKey(tabId));
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url) cancelCloudRequests(tabId);
  if (change.status === "loading" || change.url) cancelLinkPreviews(tabId);
  if (change.status === "loading" || change.url) cancelPageJudge(tabId);
});
