import type { PageCapture } from "./capture";
import type { WebResult } from "./judge-channel";
import type { PageTarget } from "./content-scope";

export interface OverlayResult {
  target?: PageTarget;
  name: string;
  item?: { index: number; label: string; selector: string };
  error?: string;
  answers: { name: string; value: string; details: string[] }[];
}
export interface OverlayData {
  jobId: string;
  url: string;
  phase: "running" | "complete" | "error" | "cancelled";
  message: string;
  results: OverlayResult[];
}
export function summarizeResult(
  name: string,
  result: WebResult,
): OverlayResult {
  return {
    name: result.evaluation.diagnostics?.fallback
      ? `${name}（ローカルへフォールバック）`
      : name,
    answers: Object.entries(result.evaluation.response.answers).map(
      ([id, answer]) => {
        const meta = result.presentation[id];
        return {
          name: meta.alias,
          value:
            answer.type === "choice"
              ? answer.choice
              : answer.type === "noul"
                ? `当てはまり ${(answer.noul * 100).toFixed(1)}%`
                : `${answer.score.toFixed(2)} / ${meta.labels.length - 1} 点`,
          details:
            answer.type === "noul"
              ? []
              : Object.entries(answer.probabilities).map(
                  ([label, p]) =>
                    `${answer.type === "score" ? meta.labels[Number(label)] : label}：${(p * 100).toFixed(1)}%`,
                ),
        };
      },
    ),
  };
}

// Serialized into the isolated world by executeScript. No module references.
export function renderOverlay(data: OverlayData): boolean {
  if (location.href !== data.url) return false;
  const globals = globalThis as typeof globalThis & {
    __jevPageTargets?: { nodes: Map<string, WeakRef<Element>> };
    __jevOverlay?: {
      jobId: string;
      host: HTMLElement;
      root: ShadowRoot;
      dismissed: boolean;
      escape: (e: KeyboardEvent) => void;
      watch?: ReturnType<typeof setInterval>;
      clearHighlight?: () => void;
      activeIndex?: number;
      position?: { x: number; y: number };
      drag?: { pointerId: number; offsetX: number; offsetY: number };
      cleanupMove?: () => void;
    };
  };
  let state = globals.__jevOverlay;
  if (state?.jobId === data.jobId && state.dismissed) return false;
  if (!state || state.jobId !== data.jobId) {
    if (state) {
      state.clearHighlight?.();
      state.cleanupMove?.();
      clearInterval(state.watch);
      state.host.remove();
      document.removeEventListener("keydown", state.escape);
    }
    const host = document.createElement("div");
    host.dataset.jevOverlay = "";
    host.style.cssText =
      "all:initial!important;position:fixed!important;top:16px!important;right:16px!important;width:min(380px,calc(100vw - 32px))!important;max-height:calc(100vh - 32px)!important;z-index:2147483647!important;display:block!important;color-scheme:light!important";
    const root = host.attachShadow({ mode: "closed" });
    state = {
      jobId: data.jobId,
      host,
      root,
      dismissed: false,
      escape: () => {},
      position: state?.position,
    };
    globals.__jevOverlay = state;
    document.documentElement.append(host);
    state.escape = (event) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", state.escape);
    host.onpointermove = (event) => {
      const drag = current.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      place(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    };
    const endMove = () => {
      const drag = current.drag;
      current.drag = undefined;
      host.removeAttribute("data-dragging");
      if (drag && host.hasPointerCapture(drag.pointerId))
        host.releasePointerCapture(drag.pointerId);
    };
    host.onpointerup = endMove;
    host.onpointercancel = endMove;
    host.onlostpointercapture = endMove;
    const resize = () => place();
    window.addEventListener("resize", resize);
    window.addEventListener("blur", endMove);
    state.cleanupMove = () => {
      endMove();
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", endMove);
    };
    state.watch = setInterval(() => {
      if (location.href !== data.url || !current.host.isConnected) close();
    }, 500);
  }
  const current = state;
  function place(x = current.position?.x, y = current.position?.y) {
    if (x === undefined || y === undefined) return;
    const rect = current.host.getBoundingClientRect();
    current.position = {
      x: Math.max(16, Math.min(x, innerWidth - rect.width - 16)),
      y: Math.max(16, Math.min(y, innerHeight - rect.height - 16)),
    };
    current.host.style.setProperty("right", "auto", "important");
    current.host.style.setProperty(
      "left",
      `${current.position.x}px`,
      "important",
    );
    current.host.style.setProperty(
      "top",
      `${current.position.y}px`,
      "important",
    );
  }
  function close() {
    if (!current || current.dismissed) return;
    current.dismissed = true;
    current.clearHighlight?.();
    current.cleanupMove?.();
    clearInterval(current.watch);
    current.host.remove();
    document.removeEventListener("keydown", current.escape);
    void chrome.runtime
      .sendMessage({ type: "jev-overlay-cancel", jobId: data.jobId })
      .catch(() => {});
  }
  const root = current.root;
  const oldScroll = root.querySelector(".box")?.scrollTop ?? 0;
  const focusedIndex = (
    root.activeElement?.closest("section") as HTMLElement | null
  )?.dataset.resultIndex;
  const activeIndex = current.activeIndex;
  const handleFocused = root.activeElement?.classList.contains("move-handle");
  current.clearHighlight?.();
  root.replaceChildren();
  const style = document.createElement("style");
  style.textContent = `:host{all:initial}*{box-sizing:border-box}.box{font:14px/1.6 system-ui,'Yu Gothic',sans-serif;color:#233c36;background:#fff;border:1px solid #b8cfc2;border-radius:14px;box-shadow:0 12px 48px #1236;max-height:calc(100vh - 32px);overflow:auto;padding:16px;overflow-wrap:anywhere}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:16px;margin:0}h3{font-size:14px;margin:0 0 8px}p{margin:6px 0}button{font:inherit;padding:5px 10px;border:1px solid #bfd1c5;border-radius:6px;background:#f3f7f4;color:#23533f;cursor:pointer}.close{font-size:20px;padding:0 8px}section{border-top:1px solid #dce7e0;margin-top:12px;padding-top:12px}.value{font-size:20px;font-weight:700}.muted{font-size:12px;color:#607969}.error{color:#a1323d}`;
  const box = document.createElement("div");
  style.textContent += `header{cursor:grab;touch-action:none;position:sticky;top:-16px;background:#fff;z-index:3;padding:8px 0;margin-top:-8px}header h2{flex:1;min-width:0}.move-handle{font:inherit;font-weight:700;background:transparent;border:0;padding:0;text-align:left;width:100%;cursor:grab;touch-action:none;user-select:none}.move-handle:focus-visible{outline:2px solid #2878dd;outline-offset:4px}:host([data-dragging]) header,:host([data-dragging]) .move-handle{cursor:grabbing}`;
  style.textContent += `section[data-result-index]{cursor:default;border-radius:6px}section[data-result-index]:hover,section[data-result-index]:focus-visible{background:#edf5ff;outline:2px solid #3077cf;outline-offset:4px}.target-highlight{position:fixed;pointer-events:none;border:3px solid #2878dd;background:#2878dd22;box-shadow:0 0 0 2px #fff9;z-index:1}.target-label{position:absolute;left:0;top:0;max-width:100%;padding:2px 6px;background:#195cb2;color:white;font:12px/1.5 system-ui;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.box{position:relative;z-index:2}`;
  const highlight = document.createElement("div");
  highlight.className = "target-highlight";
  highlight.hidden = true;
  highlight.setAttribute("aria-hidden", "true");
  const targetLabel = document.createElement("span");
  targetLabel.className = "target-label";
  highlight.append(targetLabel);
  let frame = 0;
  let restoring = false;
  const sections: HTMLElement[] = [];
  const hints: HTMLElement[] = [];
  function clearHighlight() {
    cancelAnimationFrame(frame);
    highlight.hidden = true;
    box.style.opacity = "";
    current.activeIndex = undefined;
  }
  current.clearHighlight = clearHighlight;
  function locate(result: OverlayResult): Element | undefined {
    if (result.target?.token)
      return globals.__jevPageTargets?.nodes.get(result.target.token)?.deref();
    const selector = result.target?.selector ?? result.item?.selector;
    if (!selector) return;
    try {
      const nodes = document.querySelectorAll(selector);
      return nodes.length === 1 ? nodes[0] : undefined;
    } catch {
      return;
    }
  }
  function activate(index: number, scroll: boolean) {
    if (current.drag) return;
    clearHighlight();
    current.activeIndex = index;
    const result = data.results[index];
    const element = locate(result);
    const valid = () =>
      element?.isConnected &&
      !element.closest("[data-jev-overlay],[data-jev-scope-editor]") &&
      element.getClientRects().length &&
      getComputedStyle(element).visibility === "visible";
    if (scroll && valid())
      element!.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
    function paint() {
      if (!valid()) {
        highlight.hidden = true;
        box.style.opacity = "";
        hints[index].hidden = false;
        hints[index].textContent =
          "判定した要素が見つかりません。ページを再判定してください。";
        return;
      }
      const rect = element!.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        highlight.hidden = true;
        box.style.opacity = "";
        hints[index].hidden = false;
        hints[index].textContent = "判定した要素は現在表示されていません。";
        return;
      }
      hints[index].hidden = true;
      // A thumbnail in the right column may sit behind the results. Keep the
      // pointer's hit area stationary while revealing the page underneath.
      const panel = box.getBoundingClientRect();
      const left = Math.max(0, rect.left),
        right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top),
        bottom = Math.min(innerHeight, rect.bottom);
      const visibleArea = Math.max(0, right - left) * Math.max(0, bottom - top);
      const coveredArea =
        Math.max(0, Math.min(right, panel.right) - Math.max(left, panel.left)) *
        Math.max(0, Math.min(bottom, panel.bottom) - Math.max(top, panel.top));
      box.style.opacity =
        visibleArea && coveredArea > visibleArea / 2 ? "0.15" : "";
      highlight.style.left = `${rect.left - 3}px`;
      highlight.style.top = `${rect.top - 3}px`;
      highlight.style.width = `${rect.width + 6}px`;
      highlight.style.height = `${rect.height + 6}px`;
      targetLabel.textContent = `${result.name}${result.item ? ` · ${result.item.index}件目` : ""}`;
      highlight.hidden = false;
      frame = requestAnimationFrame(paint);
    }
    paint();
  }
  box.className = "box";
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", "JevWexの判定結果");
  const header = document.createElement("header");
  const title = document.createElement("h2");
  const moveHandle = document.createElement("button");
  moveHandle.type = "button";
  moveHandle.className = "move-handle";
  moveHandle.textContent = "⠿ JevWex · ページ判定";
  moveHandle.title = "ドラッグで移動（矢印キーでも移動できます）";
  moveHandle.setAttribute(
    "aria-label",
    "判定結果を移動。ドラッグまたは矢印キーで移動",
  );
  title.append(moveHandle);
  header.onpointerdown = (event) => {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      (event.target as Element).closest(".close")
    )
      return;
    event.preventDefault();
    current.clearHighlight?.();
    moveHandle.focus({ preventScroll: true });
    const rect = current.host.getBoundingClientRect();
    current.drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    current.host.setAttribute("data-dragging", "");
    current.host.setPointerCapture(event.pointerId);
  };
  moveHandle.onkeydown = (event) => {
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = current.host.getBoundingClientRect(),
      step = event.shiftKey ? 60 : 20;
    current.clearHighlight?.();
    place(rect.left + direction[0] * step, rect.top + direction[1] * step);
  };
  const dismiss = document.createElement("button");
  dismiss.className = "close";
  dismiss.textContent = "×";
  dismiss.setAttribute("aria-label", "判定結果を閉じる");
  dismiss.onclick = close;
  header.append(title, dismiss);
  box.append(header);
  const message = document.createElement("p");
  message.textContent = data.message;
  message.className = data.phase === "error" ? "error" : "";
  message.setAttribute("role", data.phase === "error" ? "alert" : "status");
  box.append(message);
  if (data.results.some((result) => result.target || result.item?.selector)) {
    const guide = document.createElement("p");
    guide.className = "muted";
    guide.textContent =
      "結果にカーソルを合わせると、対応する要素を表示します。";
    box.append(guide);
  }
  for (const [index, result] of data.results.entries()) {
    const section = document.createElement("section");
    sections.push(section);
    const hint = document.createElement("p");
    hints.push(hint);
    if (result.target || result.item?.selector) {
      section.dataset.resultIndex = String(index);
      section.tabIndex = 0;
      section.setAttribute(
        "aria-label",
        `${result.name}${result.item ? ` ${result.item.index}件目` : ""}の判定結果。対象をページ上に表示`,
      );
      section.onmouseenter = () => activate(index, true);
      section.onmouseleave = () => {
        if (root.activeElement !== section) clearHighlight();
      };
      section.onfocus = () => activate(index, !restoring);
      section.onblur = () => {
        if (!section.matches(":hover")) clearHighlight();
      };
      section.onclick = () => activate(index, true);
      hint.className = "muted";
      hint.hidden = true;
      hint.setAttribute("role", "status");
      section.append(hint);
    }
    const name = document.createElement("h3");
    name.textContent = result.name;
    section.append(name);
    if (result.item) {
      const item = document.createElement("p");
      item.className = "muted";
      item.textContent = `${result.item.index}件目：${result.item.label}`;
      section.append(item);
    }
    if (result.error) {
      const error = document.createElement("p");
      error.className = "error";
      error.textContent = result.error;
      section.append(error);
    }
    for (const answer of result.answers) {
      const label = document.createElement("p");
      label.textContent = answer.name;
      const value = document.createElement("p");
      value.className = "value";
      value.textContent = answer.value;
      section.append(label, value);
      for (const detail of answer.details) {
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = detail;
        section.append(p);
      }
    }
    box.append(section);
  }
  if (data.results.length) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "割合はモデルの候補間の重みで、正答率ではありません。";
    box.append(note);
  }
  if (data.phase === "running") {
    const cancel = document.createElement("button");
    cancel.textContent = "中止";
    cancel.onclick = () => {
      cancel.disabled = true;
      void chrome.runtime
        .sendMessage({ type: "jev-overlay-cancel", jobId: data.jobId })
        .catch(() => {});
    };
    box.append(cancel);
  }
  if (data.phase === "error") {
    const manage = document.createElement("button");
    manage.textContent = "管理画面を開く";
    manage.onclick = () => {
      void chrome.runtime
        .sendMessage({ type: "jev-open-management" })
        .catch(() => {});
    };
    box.append(manage);
  }
  root.append(style, highlight, box);
  box.scrollTop = oldScroll;
  place();
  if (handleFocused) moveHandle.focus({ preventScroll: true });
  if (focusedIndex !== undefined) {
    restoring = true;
    sections[Number(focusedIndex)]?.focus({ preventScroll: true });
    restoring = false;
  }
  if (activeIndex !== undefined && sections[activeIndex])
    activate(activeIndex, false);
  return current.host.isConnected;
}

export async function showOverlay(capture: PageCapture, data: OverlayData) {
  const [result] = await chrome.scripting.executeScript({
    target: capture.documentId
      ? { tabId: capture.tabId, documentIds: [capture.documentId] }
      : { tabId: capture.tabId },
    func: renderOverlay,
    args: [data],
  });
  return result?.result === true;
}
