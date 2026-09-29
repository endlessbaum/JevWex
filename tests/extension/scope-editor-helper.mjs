import { build } from "esbuild";

// Exercise the standalone scope extractor/editor without a panel entry button.
// The current user flow is covered by target-rules.mjs; these older scenarios
// also verify compatibility with URL-wide scope settings.
const { outputFiles } = await build({
  entryPoints: ["src/extension/content-scope.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { pageContent } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

export async function openStandaloneScopeEditor(panel) {
  await panel.evaluate(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    url.hash = "";
    const key = "jev-content-scope:" + url.href;
    const stored = await chrome.storage.local.get(key);
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: ${pageContent.toString()},
      args: [stored[key] ?? { root: null, exclude: [] }, true, tab.url],
    });
    if (!injection?.result) throw new Error("Scope editor did not open");
    if (injection.result.error) {
      const [editor] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!document.querySelector("[data-jev-scope-editor]") });
      if (!editor?.result) throw new Error(injection.result.error);
    }
  })()`);
}
