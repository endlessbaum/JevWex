import type { SiteRule } from "./site-rules";

export interface InputRevision {
  token: string;
  revision: number;
}
export interface InputMonitorRule {
  id: string;
  selector: string;
  // Changing criteria also invalidates a queued judgement.
  version: string;
}
export function inputMonitorRules(rules: SiteRule[]): InputMonitorRule[] {
  return rules
    .filter(
      (rule) =>
        rule.enabled && rule.watchInput && rule.contentScope?.inputValue,
    )
    .map((rule) => ({
      id: rule.id,
      selector: rule.contentScope!.root!,
      version: JSON.stringify(rule),
    }));
}

// Serialized by executeScript into the isolated world. No module references.
export function installInputMonitor(rules: InputMonitorRule[], url: string) {
  if (location.href !== url) return false;
  const globals = globalThis as typeof globalThis & {
    __jevInputMonitor?: {
      token: string;
      revision: number;
      signature: string;
      rules: InputMonitorRule[];
      stop: () => void;
    };
    __jevOverlay?: {
      monitor?: InputRevision;
      host: HTMLElement;
      clearHighlight?: () => void;
      cleanupMove?: () => void;
      watch?: ReturnType<typeof setInterval>;
      dismissed: boolean;
      escape: (event: KeyboardEvent) => void;
    };
  };
  const signature = JSON.stringify([url, rules]);
  if (globals.__jevInputMonitor?.signature === signature) return true;
  globals.__jevInputMonitor?.stop();
  delete globals.__jevInputMonitor;
  if (!rules.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();
  const composing = new Set<Element>();
  const state = {
    token: crypto.randomUUID(),
    revision: 0,
    signature,
    rules,
    stop,
  };
  globals.__jevInputMonitor = state;
  function discardResult() {
    const overlay = globals.__jevOverlay;
    if (overlay?.monitor) {
      overlay.clearHighlight?.();
      overlay.cleanupMove?.();
      clearInterval(overlay.watch);
      overlay.dismissed = true;
      overlay.host.remove();
      document.removeEventListener("keydown", overlay.escape);
    }
  }
  function send(type: "jev-input-changed" | "jev-input-ready") {
    void chrome.runtime
      .sendMessage({
        type,
        url,
        token: state.token,
        revision: state.revision,
        ruleIds: [...pending],
      })
      .catch(() => stop());
  }
  function affected(
    event: Event,
  ): { target: Element; ids: string[] } | undefined {
    if (location.href !== url) {
      stop();
      return;
    }
    const target = event.target;
    if (
      !(target instanceof HTMLElement) ||
      target.closest("[data-jev-overlay],[data-jev-scope-editor]") ||
      !(
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement &&
          ["text", "search", "url", "email", "tel"].includes(target.type)) ||
        target.isContentEditable
      )
    )
      return;
    const ids = rules
      .filter((rule) => {
        try {
          const nodes = document.querySelectorAll(rule.selector);
          const root = nodes.length === 1 ? nodes[0] : undefined;
          return (
            root === target ||
            (root instanceof HTMLElement &&
              root.isContentEditable &&
              root.contains(target))
          );
        } catch {
          return false;
        }
      })
      .map((rule) => rule.id);
    return ids.length ? { target, ids } : undefined;
  }
  function changed(event: Event) {
    const match = affected(event);
    if (!match) return;
    clearTimeout(timer);
    for (const id of match.ids) pending.add(id);
    for (const element of composing)
      if (!element.isConnected) composing.delete(element);
    state.revision++;
    discardResult();
    send("jev-input-changed");
    if (event.type === "compositionstart") composing.add(match.target);
    if (event.type === "compositionend") composing.delete(match.target);
    if (composing.size || (event as InputEvent).isComposing) return;
    timer = setTimeout(() => {
      if (location.href !== url || composing.size) return;
      send("jev-input-ready");
      pending.clear();
    }, 50);
  }
  function stop() {
    clearTimeout(timer);
    document.removeEventListener("input", changed, true);
    document.removeEventListener("compositionstart", changed, true);
    document.removeEventListener("compositionend", changed, true);
    window.removeEventListener("pagehide", stop);
    discardResult();
    if (globals.__jevInputMonitor === state) delete globals.__jevInputMonitor;
  }
  document.addEventListener("input", changed, true);
  document.addEventListener("compositionstart", changed, true);
  document.addEventListener("compositionend", changed, true);
  window.addEventListener("pagehide", stop, { once: true });
  return true;
}

// Read in the sender's document so old timers cannot judge a replacement page.
export function readInputMonitor() {
  const state = (
    globalThis as typeof globalThis & {
      __jevInputMonitor?: InputRevision & { rules: InputMonitorRule[] };
    }
  ).__jevInputMonitor;
  return state
    ? { token: state.token, revision: state.revision, rules: state.rules }
    : null;
}
