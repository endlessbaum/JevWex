import { startPageJudge } from "./page-judge";

export async function handlePageCommand(
  command: string,
  tab?: chrome.tabs.Tab,
  start: (tabId: number) => string = startPageJudge,
) {
  if (command !== "evaluate-page") return;
  const target =
    tab?.id !== undefined
      ? tab
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target?.id === undefined) return;
  try {
    start(target.id);
  } catch (error) {
    await chrome.action.setTitle({
      tabId: target.id,
      title: (error as Error).message,
    });
  }
}
