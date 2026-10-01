import { normalizeUrl } from "./site-rules";

export interface PageTarget {
  selector: string;
  token: string;
}

export interface ContentScope {
  root: string | null;
  exclude: string[];
  items?: string;
  images?: boolean;
  linkedPages?: boolean;
  inputValue?: boolean;
  sharedExclude?: { container: string; items: string; path: string }[];
}
export const scopeKey = (url: string) =>
  `jev-content-scope:${normalizeUrl(url)}`;
export function validateScope(value: unknown): ContentScope {
  const s = value as ContentScope;
  if (
    !s ||
    (s.inputValue !== undefined && typeof s.inputValue !== "boolean") ||
    (s.inputValue === true &&
      (!s.root || s.items || s.images || s.linkedPages)) ||
    (s.images !== undefined && typeof s.images !== "boolean") ||
    (s.linkedPages !== undefined && typeof s.linkedPages !== "boolean") ||
    (s.images === true && s.linkedPages === true) ||
    (s.root !== null &&
      (typeof s.root !== "string" || !s.root || s.root.length > 4000)) ||
    !Array.isArray(s.exclude) ||
    s.exclude.length > 64 ||
    s.exclude.some((x) => typeof x !== "string" || !x || x.length > 4000) ||
    (s.items !== undefined &&
      (typeof s.items !== "string" ||
        !s.items ||
        s.items.length > 4000 ||
        !s.root)) ||
    (s.sharedExclude !== undefined &&
      (!Array.isArray(s.sharedExclude) ||
        s.sharedExclude.length + s.exclude.length > 64 ||
        s.sharedExclude.some(
          (rule) =>
            !rule ||
            [rule.container, rule.items, rule.path].some(
              (value) =>
                typeof value !== "string" || !value || value.length > 4000,
            ),
        )))
  )
    throw new Error("本文範囲の設定が正しくありません。");
  return {
    root: s.root,
    exclude: [...new Set(s.exclude)],
    ...(s.items ? { items: s.items } : {}),
    ...(s.images ? { images: true } : {}),
    ...(s.linkedPages ? { linkedPages: true } : {}),
    ...(s.inputValue ? { inputValue: true } : {}),
    ...(s.sharedExclude?.length
      ? {
          sharedExclude: s.sharedExclude.map(({ container, items, path }) => ({
            container,
            items,
            path,
          })),
        }
      : {}),
  };
}
export async function readScope(url: string): Promise<ContentScope> {
  const key = scopeKey(url),
    data = await chrome.storage.local.get(key);
  return data[key] ? validateScope(data[key]) : { root: null, exclude: [] };
}
export function describeScope(scope?: ContentScope): string {
  if (!scope) return "本文を自動選択";
  const excluded = scope.exclude.length + (scope.sharedExclude?.length ?? 0);
  return `${scope.root ?? "本文を自動選択"} · ${scope.inputValue ? "入力欄の値を判定" : scope.items ? "子要素を1件ずつ" : "まとめて判定"}${scope.images ? " · 画像を含む" : ""}${scope.linkedPages ? " · リンク先の本文を判定" : ""}${excluded ? ` · 除外設定 ${excluded}件` : ""}`;
}

// Runs in the isolated world; keep every DOM helper inside this function.
export function pageContent(
  scope: ContentScope,
  editing = false,
  expectedUrl?: string,
  draftKey?: string,
) {
  try {
    if (expectedUrl && location.href !== expectedUrl)
      throw new Error("ページが移動しました。再取得してください。");
    const ignored =
      "script,style,noscript,template,select,input[type]:not([type=text i]):not([type=search i]):not([type=url i]):not([type=email i]):not([type=tel i]),[data-jev-overlay],[data-jev-scope-editor]";
    const textEntry = (el: Element) =>
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement &&
        ["text", "search", "url", "email", "tel"].includes(el.type)) ||
      (el instanceof HTMLElement &&
        el.isContentEditable &&
        !el.parentElement?.isContentEditable);
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        !el.hasAttribute("hidden")
      );
    };
    function selector(el: Element): string {
      if (el.id) {
        const id = `#${CSS.escape(el.id)}`;
        if (document.querySelectorAll(id).length === 1) return id;
      }
      if (el === document.body) return "body";
      const parent = el.parentElement;
      if (!parent) return "html";
      const siblings = [...parent.children].filter(
        (child) => child.tagName === el.tagName,
      );
      const part =
        el.tagName.toLowerCase() +
        (siblings.length > 1
          ? `:nth-of-type(${siblings.indexOf(el) + 1})`
          : "");
      return `${selector(parent)} > ${part}`;
    }
    // Keep the actual element identity across reordering. A replaced DOM node
    // must never inherit an old result just because its selector is the same.
    const pageState = globalThis as typeof globalThis & {
      __jevPageTargets?: {
        ids: WeakMap<Element, string>;
        nodes: Map<string, WeakRef<Element>>;
      };
    };
    const targets = (pageState.__jevPageTargets ??= {
      ids: new WeakMap(),
      nodes: new Map(),
    });
    for (const [token, node] of targets.nodes)
      if (!node.deref()?.isConnected) targets.nodes.delete(token);
    function reference(el: Element): PageTarget {
      let token = targets.ids.get(el);
      if (!token) {
        token = [...crypto.getRandomValues(new Uint32Array(4))]
          .map((value) => value.toString(16))
          .join("-");
        targets.ids.set(el, token);
      }
      targets.nodes.set(token, new WeakRef(el));
      return { selector: selector(el), token };
    }
    const label = (el: Element) =>
      el.tagName.toLowerCase() +
      (el.id ? `#${el.id}` : "") +
      (el.getAttribute("role") ? `[${el.getAttribute("role")}]` : "");
    const candidates = [
      ...document.querySelectorAll("main,[role=main],article"),
    ].filter(
      (el) => visible(el) && el.getClientRects().length && !el.closest(ignored),
    );
    candidates.sort(
      (a, b) =>
        ((b as HTMLElement).innerText?.length ?? 0) -
        ((a as HTMLElement).innerText?.length ?? 0),
    );
    const automatic = candidates[0] ?? document.body;
    let root: Element = automatic;
    const excluded = new Set<Element>();
    const specificExcluded = new Set<Element>();
    let sharedExclude = (scope.sharedExclude ?? []).map((rule) => ({
      ...rule,
    }));
    let itemSelector = scope.items;
    let includeImages = scope.images === true;
    let linkedPages = scope.linkedPages === true;
    let inputValue = scope.inputValue === true;
    const warnings: string[] = [];
    function unique(path: string): Element | undefined {
      const nodes = document.querySelectorAll(path);
      return nodes.length === 1 ? nodes[0] : undefined;
    }
    if (scope.root) {
      root = unique(scope.root)!;
      if (!root || !visible(root) || !root.getClientRects().length) {
        if (!editing)
          throw new Error(
            "保存した本文範囲が見つかりません。パネルの「対象を調整する」で選び直してください。",
          );
        root = automatic;
        warnings.push(
          "保存した範囲が見つからないため候補を表示しています。選び直して保存してください。",
        );
      }
    }
    for (const path of scope.exclude) {
      const node = unique(path);
      if (node && node !== root && root.contains(node))
        specificExcluded.add(node);
      else
        warnings.push(
          "保存した除外要素が見つかりません。範囲を調整してください。",
        );
    }
    // Match positions relative to each item; item-specific IDs are deliberately
    // omitted so a rule also applies to newly loaded siblings.
    function relativePath(item: Element, el: Element): string {
      const parts: string[] = [];
      for (let node = el; node !== item; node = node.parentElement!) {
        const siblings = [...node.parentElement!.children].filter(
          (child) => child.tagName === node.tagName,
        );
        parts.unshift(
          `${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`,
        );
      }
      return `:scope > ${parts.join(" > ")}`;
    }
    function sharedRule(el: Element) {
      if (itemSelector) {
        const item = [...root.querySelectorAll(itemSelector)].find((item) =>
          item.contains(el),
        );
        if (item)
          return item === el
            ? undefined
            : {
                container: selector(root),
                items: itemSelector,
                path: relativePath(item, el),
              };
      }
      let fallback: Element | undefined;
      for (
        let item: Element | null = el;
        item && item !== root;
        item = item.parentElement
      ) {
        const container = item.parentElement;
        if (!container || !root.contains(container)) break;
        const peers = container.querySelectorAll(pattern(item));
        if (peers.length < 2) continue;
        if (
          (item.tagName === "LI" && /^(UL|OL)$/.test(container.tagName)) ||
          (item.tagName === "TR" &&
            /^(TBODY|THEAD|TFOOT|TABLE)$/.test(container.tagName)) ||
          item.getAttribute("role") === "listitem"
        )
          return item === el
            ? undefined
            : {
                container: selector(container),
                items: pattern(item),
                path: relativePath(item, el),
              };
        if (item !== el && item.classList.length) fallback = item;
      }
      return fallback
        ? {
            container: selector(fallback.parentElement!),
            items: pattern(fallback),
            path: relativePath(fallback, el),
          }
        : undefined;
    }
    function sharedNodes(
      rule: NonNullable<ContentScope["sharedExclude"]>[number],
    ) {
      const container = unique(rule.container);
      if (!container || (container !== root && !root.contains(container)))
        return [];
      return [...container.querySelectorAll(rule.items)]
        .flatMap((item) => [...item.querySelectorAll(rule.path)])
        .filter((node) => node !== root && root.contains(node));
    }
    function rebuildExclusions() {
      excluded.clear();
      for (const node of specificExcluded)
        if (root.contains(node) && node !== root) excluded.add(node);
      for (const rule of sharedExclude)
        for (const node of sharedNodes(rule)) excluded.add(node);
    }
    function promoteExclusions() {
      for (const node of specificExcluded) {
        const rule = sharedRule(node);
        if (!rule) continue;
        specificExcluded.delete(node);
        if (
          !sharedExclude.some(
            (saved) => JSON.stringify(saved) === JSON.stringify(rule),
          )
        )
          sharedExclude.push(rule);
      }
      rebuildExclusions();
    }
    for (const rule of sharedExclude) {
      const container = unique(rule.container);
      if (!container || (container !== root && !root.contains(container)))
        warnings.push(
          "共通除外のリストが見つかりません。範囲を調整してください。",
        );
    }
    promoteExclusions();
    if (warnings.length && !editing) throw new Error(warnings[0]);
    if (inputValue && !textEntry(root) && !editing)
      throw new Error(
        "保存した対象はテキスト入力欄ではありません。対象を選び直してください。",
      );
    if (editing && !textEntry(root)) inputValue = false;
    function read(el: Element, omissions = excluded): string {
      if (omissions.has(el) || el.matches(ignored) || !visible(el)) return "";
      if (
        inputValue &&
        el === root &&
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
      )
        return el.value;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        return "";
      let text = "";
      const preserve = /pre|break-spaces/.test(getComputedStyle(el).whiteSpace);
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE)
          text += preserve
            ? child.textContent
            : child.textContent?.replace(/\s+/g, " ");
        else if (child instanceof Element) {
          if (child.tagName === "BR") {
            text += "\n";
            continue;
          }
          const block = !/^(inline|contents)/.test(
            getComputedStyle(child).display,
          );
          const part = read(child, omissions);
          if (part) text += block ? `\n${part}\n` : part;
        }
      }
      return text;
    }
    const clean = (text: string) =>
      text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    function images(el: Element, omissions = excluded) {
      if (!includeImages) return [];
      const nodes =
        el instanceof HTMLImageElement ? [el] : [...el.querySelectorAll("img")];
      return nodes
        .filter((img) => {
          if (!img.getClientRects().length || img.closest(ignored))
            return false;
          for (
            let node: Element | null = img;
            node;
            node = node.parentElement
          ) {
            if (omissions.has(node) || !visible(node)) return false;
          }
          return true;
        })
        .map((img) => ({
          url: img.currentSrc || img.src,
          label: img.alt.slice(0, 200) || "画像",
        }));
    }
    function links(el: Element) {
      if (!linkedPages) return [];
      const nodes =
        el instanceof HTMLAnchorElement
          ? [el]
          : [...el.querySelectorAll<HTMLAnchorElement>("a[href]")];
      return nodes
        .filter((a) => {
          if (
            a.hasAttribute("download") ||
            !a.getClientRects().length ||
            a.closest(ignored)
          )
            return false;
          for (let node: Element | null = a; node; node = node.parentElement)
            if (excluded.has(node) || !visible(node)) return false;
          return true;
        })
        .flatMap((a) => {
          try {
            const href = a.getAttribute("href");
            if (!href?.trim() || href.trim().startsWith("#")) return [];
            const url = new URL(a.href);
            if (
              !/^https?:$/.test(url.protocol) ||
              url.username ||
              url.password ||
              url.href.length > 4000
            )
              return [];
            url.hash = "";
            return [
              {
                url: url.href,
                label:
                  clean(read(a)).replace(/\s+/g, " ").slice(0, 200) ||
                  a.getAttribute("aria-label")?.slice(0, 200) ||
                  a.querySelector("img")?.alt.slice(0, 200) ||
                  "リンク",
              },
            ];
          } catch {
            return [];
          }
        });
    }
    function items() {
      if (!itemSelector) return undefined;
      const matched = [...root.querySelectorAll(itemSelector)].filter(
        (el) =>
          visible(el) &&
          el.getClientRects().length &&
          !el.closest(ignored) &&
          ![...excluded].some((omit) => omit.contains(el)),
      );
      const entries = matched
        .map((el) => ({
          el,
          text: clean(read(el)),
          images: images(el),
          links: links(el),
        }))
        .filter(
          (entry) => entry.text || entry.images.length || entry.links.length,
        );
      if (!entries.length)
        throw new Error(
          "1件分の要素が見つかりません。範囲を調整してください。",
        );
      if (
        entries.some(({ el }) =>
          entries.some(({ el: other }) => el !== other && other.contains(el)),
        )
      )
        throw new Error(
          "1件分の要素が入れ子で重複しています。外側の繰り返し要素を選び直してください。",
        );
      return entries.map(({ el, text, images, links }, index) => ({
        target: reference(el),
        index: index + 1,
        selector: selector(el),
        label:
          text.replace(/\s+/g, " ").slice(0, 100) ||
          images[0]?.label ||
          links[0]?.label ||
          "画像",
        ...(includeImages ? { images } : {}),
        ...(linkedPages ? { links } : {}),
        text: text.slice(0, 48000),
        truncated: text.length > 48000,
      }));
    }
    function result() {
      const text = clean(read(root));
      const entries = items();
      const active = document.activeElement;
      const selection =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active?.matches("[data-jev-overlay],[data-jev-scope-editor]")
          ? ""
          : (window.getSelection()?.toString().trim() ?? "");
      return {
        url: location.href,
        target: reference(root),
        title: document.title.slice(0, 1000),
        text: text.slice(0, 48000),
        selection: selection.slice(0, 48000),
        ...(includeImages ? { images: entries ? [] : images(root) } : {}),
        ...(linkedPages ? { links: entries ? [] : links(root) } : {}),
        truncated: text.length > 48000,
        selectionTruncated: selection.length > 48000,
        capturedAt: new Date().toISOString(),
        ...(entries ? { items: entries } : {}),
        contentScope: {
          root: selector(root),
          label: label(root),
          excluded: excluded.size,
          automatic: !scope.root,
          characters: entries
            ? entries.reduce((sum, item) => sum + item.text.length, 0)
            : text.length,
          originalCharacters: clean(read(document.body, new Set())).length,
        },
      };
    }
    if (!editing) return result();

    const state = globalThis as typeof globalThis & {
      __jevScopeClose?: () => void;
    };
    state.__jevScopeClose?.();
    const originalUrl = location.href;
    const host = document.createElement("div");
    host.setAttribute("data-jev-scope-editor", "");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("inset", "0", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("pointer-events", "none", "important");
    document.documentElement.append(host);
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host{all:initial}*{box-sizing:border-box}.box{position:fixed;top:12px;right:12px;width:min(380px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;background:#fff;color:#213b33;border:1px solid #c5d9cf;border-radius:12px;box-shadow:0 8px 40px #0004;padding:16px;font:14px/1.5 system-ui,sans-serif;pointer-events:auto}h2{font-size:17px;margin:0 0 8px}p{margin:8px 0}button,select{font:inherit;color:inherit;background:#f2f7f4;border:1px solid #bfd2c6;border-radius:6px;padding:6px 8px;cursor:pointer;max-width:100%}button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.primary{background:#256749;color:white}.active{background:#e0edff;border-color:#2563eb}.tree{max-height:230px;overflow:auto;border:1px solid #dce5df;padding:8px}.tree details{margin-left:12px}.tree summary{cursor:pointer;overflow-wrap:anywhere}.tree button{font-size:11px;padding:1px 4px;margin:0 4px}.tree input{accent-color:#257149}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:150px;overflow:auto;font:12px/1.5 system-ui;background:#f2f6f3;padding:8px}.muted{font-size:12px;color:#546b61}.error{color:#a32424}.outline{position:fixed;pointer-events:none;border:3px solid #278653;background:#2786530b}.excluded{border-color:#c63b42;background:repeating-linear-gradient(135deg,#c63b4218 0px,#c63b4218 5px,transparent 5px,transparent 10px)}.hover{border-color:#2563eb;background:#2563eb12}`;
    style.textContent += `.processing{margin:5px 0 7px 18px;padding-left:8px;border-left:2px solid #c5d9cf}.processing label{display:block;font-size:12px;margin:3px 0}.processing select{font-size:12px;padding:3px 5px}select:disabled{opacity:.5;cursor:default}`;
    style.textContent += `.box{display:flex;flex-direction:column;overflow:hidden;padding:0}.content{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:16px;touch-action:pan-y}.footer{flex-shrink:0;padding:10px 16px;background:#fff;border-top:1px solid #dce5df}.footer .actions{margin:0}.preview-status{margin:0 0 8px;font-weight:600;overflow-wrap:anywhere}.preview-status[data-state=success]{color:#226749}.preview-status[data-state=error],.preview-status[data-state=partial]{color:#a32424}pre{overscroll-behavior:contain;touch-action:pan-y}`;
    style.textContent += `h3{font-size:14px;margin:0 0 8px}.section{margin-top:14px;padding-top:12px;border-top:1px solid #dce5df}.structure-controls{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.structure-controls select{width:100%}.tree{max-height:280px;border-radius:6px;padding:6px}.tree details{margin-left:10px}.tree>details{margin-left:0}.tree summary{padding:4px 0;line-height:1.8}.tree .include{display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border-radius:4px;cursor:pointer;font-size:12px;background:#edf6ef}.tree .include input{margin:0;width:14px;height:14px}.tree .removed>.include{background:#fff0f0;color:#a32424}.tree .node-name{margin-left:5px;font-family:ui-monospace,monospace}.tree button{padding:3px 5px}.options>label{display:flex;align-items:start;gap:6px;margin:8px 0}.help{font-size:12px;color:#546b61;margin-top:8px}.help>summary{cursor:pointer}.success{color:#226749}[data-scope-summary]{font-size:12px;color:#546b61}pre{margin:8px 0;max-height:200px;border-radius:6px}[hidden]{display:none!important}`;
    const outlines = document.createElement("div");
    const box = document.createElement("section");
    box.className = "box";
    shadow.append(style, outlines, box);
    const content = document.createElement("div");
    content.className = "content";
    content.tabIndex = 0;
    content.setAttribute("role", "region");
    content.setAttribute(
      "aria-label",
      "本文範囲の設定とプレビュー（スクロールできます）",
    );
    const footer = document.createElement("div");
    footer.className = "footer";
    box.append(content, footer);
    function fitEditor() {
      const rect = box.getBoundingClientRect();
      const scale = rect.width / box.offsetWidth || 1;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      box.style.maxWidth = `${Math.max(80, Math.floor((width - 24) / scale))}px`;
      const bottom = viewport
        ? viewport.offsetTop + viewport.height
        : window.innerHeight;
      box.style.maxHeight = `${Math.max(80, Math.floor((bottom - rect.top - 12) / scale))}px`;
    }
    // Page scroll libraries can cancel wheel events before they reach the editor.
    // Scroll the closest available editor region explicitly, then keep the event
    // inside the editor so the source page does not move with it.
    content.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey) return;
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? content.clientHeight
              : 1;
        const delta = event.deltaY * unit;
        for (
          let node = event.target instanceof Element ? event.target : null;
          node && content.contains(node);
          node = node.parentElement
        ) {
          if (node.scrollHeight <= node.clientHeight) continue;
          const before = node.scrollTop;
          node.scrollTop += delta;
          if (node.scrollTop !== before) break;
        }
        event.preventDefault();
        event.stopPropagation();
      },
      { passive: false },
    );
    let mode: "root" | undefined;
    let hovered: Element | undefined;
    let dirty = false;
    let saving = false;
    const make = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      text: string,
      parent: Element = content,
    ) => {
      const el = document.createElement(tag);
      el.textContent = text;
      parent.append(el);
      return el;
    };
    make("h2", "判定する本文の範囲");
    const status = make("p", warnings.join(" "));
    status.className = "error";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const summary = make("p", "");
    summary.setAttribute("data-scope-summary", "");
    const structure = make("section", "");
    structure.className = "section";
    structure.setAttribute("data-scope-structure", "");
    make("h3", "対象と除外", structure);
    const controls = make("div", "", structure);
    controls.className = "structure-controls";
    const candidatesSelect = make("select", "", controls);
    candidatesSelect.setAttribute("aria-label", "本文候補");
    for (const el of [...new Set([...candidates, document.body])]) {
      const option = make(
        "option",
        `${label(el)} · ${clean(read(el, new Set())).length.toLocaleString()}文字`,
        candidatesSelect,
      );
      option.value = selector(el);
    }
    const parent = make("button", "親要素へ", controls);
    const pick = make("button", "ページ上で対象を選ぶ", controls);
    make(
      "p",
      "チェックを外すと除外、戻すと解除。ページ上では Alt＋クリックでも切り替えられます。",
      structure,
    ).className = "muted";
    const tree = make("div", "", structure);
    tree.className = "tree";
    tree.setAttribute("aria-label", "HTMLの構造と除外");
    const help = make("details", "", structure);
    help.className = "help";
    make("summary", "操作と判定の説明", help);
    make(
      "p",
      "緑＝対象、赤＝除外。「この要素以下に絞る」で範囲を狭め、「親要素へ」で一段広げます。",
      help,
    );
    make(
      "p",
      "リスト・カード内の子要素を外すと、同じ並びの全項目で同じ位置を除外します。どれか1件でチェックを戻すと全件に戻ります。項目そのもののチェックは、その1件だけを除外します。",
      help,
    );
    const selectedGroups = new Map<Element, string>();
    if (itemSelector) selectedGroups.set(root, itemSelector);
    function pattern(el: Element) {
      const siblings = [...(el.parentElement?.children ?? [])].filter(
        (node) => node.tagName === el.tagName && visible(node),
      );
      const commonClass = [...el.classList].find(
        (name) =>
          siblings.filter((node) => node.classList.contains(name)).length >= 2,
      );
      return `:scope > ${el.tagName.toLowerCase()}${commonClass ? `.${CSS.escape(commonClass)}` : ""}`;
    }
    function childGroups(el: Element) {
      const groups: { query: string; count: number; specific: boolean }[] = [];
      for (const child of [...el.children].slice(0, 30)) {
        if (child.matches(ignored)) continue;
        const query = pattern(child);
        if (groups.some((group) => group.query === query)) continue;
        const count = [...el.querySelectorAll(query)].filter(
          (node) =>
            visible(node) &&
            node.getClientRects().length &&
            (clean(read(node, new Set())) ||
              images(node, new Set()).length ||
              links(node).length),
        ).length;
        if (count >= 2)
          groups.push({
            query,
            count,
            specific: query !== `:scope > ${child.tagName.toLowerCase()}`,
          });
      }
      // Keep the saved choice editable even when only one item remains.
      const saved =
        el === root && itemSelector ? itemSelector : selectedGroups.get(el);
      if (saved && !groups.some((group) => group.query === saved))
        groups.push({
          query: saved,
          count: el.querySelectorAll(saved).length,
          specific: true,
        });
      return groups.sort((a, b) => Number(b.specific) - Number(a.specific));
    }
    const itemNote = make(
      "p",
      "ulなどの親要素で「まとめて判定」「子要素を1件ずつ判定」を選べます。1件ずつにすると、その親要素の中を判定対象にします。",
      help,
    );
    itemNote.className = "muted";
    make(
      "p",
      "input・textarea・編集可能な欄を対象にすると、その入力値を判定します。空欄でも保存できます。自動判定は条件画面の「入力監視」でオンにしてください。",
      help,
    ).className = "muted";
    const options = make("section", "");
    options.className = "section options";
    make("h3", "判定する内容", options);
    const imageLabel = make("label", "", options);
    const imageToggle = make("input", "", imageLabel);
    imageToggle.type = "checkbox";
    imageToggle.setAttribute("data-scope-images", "");
    imageLabel.append("対象内の画像も判定する（画像対応モデル）");
    make(
      "p",
      "imgを対象にすると画像判定がオンになります。画像を除外するには構造のチェックを外してください。画像だけでも判定できます。1件あたり4枚まで。動画本体は読み取りません。",
      help,
    ).className = "muted";
    const linkLabel = make("label", "", options);
    const linkToggle = make("input", "", linkLabel);
    linkToggle.type = "checkbox";
    linkToggle.setAttribute("data-scope-links", "");
    linkLabel.append("リンク先の本文を取得して判定する");
    make(
      "p",
      "aタグを対象にするとオンになります。contents配下、なければbody配下の本文を取得し、モデルの入力上限の80%以下の文字数に調整します。1件の対象に4リンクまで。未許可のサイトは、対象を確定後に条件画面で取得を許可してください。",
      help,
    ).className = "muted";
    const previews = make("section", "");
    previews.className = "section";
    const previewTitle = make("h3", "判定する本文のプレビュー", previews);
    const preview = make("pre", "", previews);
    preview.setAttribute("data-scope-preview", "");
    preview.tabIndex = 0;
    preview.setAttribute("aria-label", "判定する本文のプレビュー");
    const linkRefresh = make(
      "button",
      "リンク先を取得してプレビュー",
      previews,
    );
    linkRefresh.setAttribute("data-scope-link-refresh", "");
    const linkPreview = make("pre", "", previews);
    linkPreview.setAttribute("data-scope-link-preview", "");
    linkPreview.tabIndex = 0;
    linkPreview.setAttribute("aria-label", "リンク先本文のプレビュー");
    const linkStatus = make("p", "", footer);
    linkStatus.className = "preview-status";
    linkStatus.setAttribute("data-scope-link-status", "");
    linkStatus.setAttribute("role", "status");
    linkStatus.setAttribute("aria-live", "polite");
    let previewId = "",
      previewSignature = "";
    function currentScope(): ContentScope {
      return {
        root: auto ? null : selector(root),
        exclude: [...specificExcluded].map(selector),
        ...(sharedExclude.length ? { sharedExclude } : {}),
        ...(itemSelector ? { items: itemSelector } : {}),
        ...(includeImages ? { images: true } : {}),
        ...(linkedPages ? { linkedPages: true } : {}),
        ...(inputValue ? { inputValue: true } : {}),
      };
    }
    function cancelLinkPreview() {
      if (previewId)
        void chrome.runtime
          .sendMessage({
            type: "jev-cancel-link-preview",
            requestId: previewId,
          })
          .catch(() => {});
      previewId = "";
    }
    function previewLinks() {
      cancelLinkPreview();
      if (!linkedPages) return;
      const requestId = (previewId = crypto.randomUUID());
      linkStatus.dataset.state = "loading";
      linkStatus.textContent = "リンク先プレビュー：取得中…";
      linkPreview.textContent =
        "リンク先を取得しています…（プレビューは先頭4リンクの本文各3行）";
      void chrome.runtime
        .sendMessage({
          type: "jev-preview-link-scope",
          requestId,
          url: originalUrl,
          scope: currentScope(),
        })
        .then((response) => {
          if (previewId !== requestId || !host.isConnected) return;
          linkPreview.textContent =
            response?.error ?? response?.text ?? "取得できませんでした。";
          const total = response?.totalCount ?? 0;
          const success = response?.successCount ?? 0;
          linkStatus.dataset.state =
            response?.error || !success
              ? "error"
              : success < total
                ? "partial"
                : "success";
          linkStatus.textContent = response?.error
            ? `リンク先プレビュー：取得失敗 · ${response.error}`
            : total
              ? `リンク先プレビュー：${success ? "取得成功" : "取得失敗"} ${success}/${total}件${success < total ? ` · ${total - success}件失敗（詳細はプレビュー内）` : ""}`
              : "リンク先プレビュー：取得できませんでした。";
          fitEditor();
        })
        .catch((error) => {
          if (previewId === requestId && host.isConnected) {
            linkPreview.textContent = error.message;
            linkStatus.dataset.state = "error";
            linkStatus.textContent = `リンク先プレビュー：取得失敗 · ${error.message}`;
            fitEditor();
          }
        });
    }
    const actions = make("div", "", footer);
    actions.className = "actions";
    const save = make(
      "button",
      draftKey ? "この対象を使う" : "新しい条件の対象に使う",
      actions,
    );
    save.className = "primary";
    const reset = make("button", "自動選択に戻す", actions);
    const close = make("button", "閉じる", actions);
    let auto = !scope.root;
    let outlinedItems: ReturnType<typeof items>;
    function paint() {
      outlines.replaceChildren();
      for (const [el, css] of [
        [root, ""],
        ...[...excluded].map((el) => [el, "excluded"]),
        ...(hovered ? [[hovered, "hover"]] : []),
      ] as [Element, string][]) {
        if (!el.isConnected) continue;
        const rect = el.getBoundingClientRect();
        const line = document.createElement("div");
        line.className = `outline ${css}`;
        Object.assign(line.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
        outlines.append(line);
      }
      if (itemSelector) {
        try {
          for (const item of outlinedItems ?? []) {
            const el = document.querySelector(item.selector);
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            const line = document.createElement("div");
            line.className = "outline item";
            line.textContent = `${item.index}件目`;
            Object.assign(line.style, {
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
              border: "2px dashed #2864b5",
              background: "transparent",
              color: "#17467f",
              font: "bold 12px system-ui",
              textShadow: "0 0 3px white",
            });
            outlines.append(line);
          }
        } catch {
          /* The preview explains invalid item selectors. */
        }
      }
    }
    function changeRoot(el: Element) {
      if (root !== el) tree.scrollTop = 0;
      for (const rule of sharedExclude) {
        const container = unique(rule.container);
        if (!container || (container !== el && !el.contains(container)))
          for (const node of sharedNodes(rule))
            if (el.contains(node) && el !== node) specificExcluded.add(node);
      }
      sharedExclude = sharedExclude.filter((rule) => {
        const container = unique(rule.container);
        return container && (container === el || el.contains(container));
      });
      itemSelector = undefined;
      root = el;
      inputValue = textEntry(el);
      if (inputValue) {
        includeImages = false;
        linkedPages = false;
      }
      if (el instanceof HTMLImageElement) {
        includeImages = true;
        linkedPages = false;
      }
      if (el instanceof HTMLAnchorElement && el.hasAttribute("href")) {
        linkedPages = true;
        includeImages = false;
      }
      auto = false;
      dirty = true;
      mode = undefined;
      hovered = undefined;
      for (const node of specificExcluded)
        if (node === root || !root.contains(node))
          specificExcluded.delete(node);
      render();
    }
    function setExcluded(el: Element, omit: boolean) {
      if (omit) {
        if (specificExcluded.size + sharedExclude.length >= 64) {
          status.className = "error";
          status.textContent =
            "除外設定は64件までです。親要素をまとめて除外してください。";
          render();
          return;
        }
        const rule = sharedRule(el);
        if (rule) {
          if (
            !sharedExclude.some(
              (saved) => JSON.stringify(saved) === JSON.stringify(rule),
            )
          )
            sharedExclude.push(rule);
          status.textContent = `同じ並びの${sharedNodes(rule).length}箇所に除外を適用しました。`;
        } else {
          specificExcluded.add(el);
          status.textContent = `${label(el)}を除外しました。`;
        }
      } else {
        if (el instanceof HTMLImageElement) includeImages = true;
        sharedExclude = sharedExclude.filter(
          (rule) => !sharedNodes(rule).includes(el),
        );
        specificExcluded.delete(el);
        status.textContent = "対応する除外を解除しました。";
      }
      status.className = "success";
      dirty = true;
      render();
    }
    function render() {
      status.hidden = !status.textContent;
      rebuildExclusions();
      const text = clean(read(root));
      let entries: ReturnType<typeof items>;
      let itemError = "";
      try {
        entries = items();
      } catch (error) {
        itemError = (error as Error).message;
      }
      outlinedItems = entries;
      const imageCount = entries
        ? entries.reduce((sum, item) => sum + (item.images?.length ?? 0), 0)
        : images(root).length;
      imageToggle.checked = includeImages;
      imageToggle.disabled = saving || inputValue;
      linkToggle.checked = linkedPages;
      linkToggle.disabled = saving || inputValue;
      linkRefresh.hidden =
        linkPreview.hidden =
        linkStatus.hidden =
          !linkedPages;
      linkRefresh.disabled = saving;
      preview.hidden = linkedPages && !itemError;
      previewTitle.textContent = inputValue
        ? "判定する入力値のプレビュー"
        : linkedPages
          ? "リンク先本文のプレビュー"
          : "判定する本文のプレビュー";
      const linkCount = entries
        ? entries.reduce((sum, item) => sum + (item.links?.length ?? 0), 0)
        : links(root).length;
      if (linkedPages) {
        const signature = JSON.stringify([
          currentScope(),
          entries?.map((item) => item.links) ?? links(root),
        ]);
        if (signature !== previewSignature) {
          previewSignature = signature;
          previewLinks();
        }
      } else {
        cancelLinkPreview();
        previewSignature = "";
      }
      summary.textContent = linkedPages
        ? `${label(root)} · リンク先 ${linkCount}件 · 除外 ${excluded.size}件`
        : `${label(root)} · ${(entries ? entries.reduce((sum, item) => sum + item.text.length, 0) : text.length).toLocaleString()}文字 / ページ全体 ${clean(read(document.body, new Set())).length.toLocaleString()}文字 · 除外 ${excluded.size}件${(entries ? entries.some((item) => item.truncated) : text.length > 48000) ? "（1件の取得は先頭48,000文字まで）" : ""}`;
      if (itemSelector)
        summary.textContent += ` · ${entries?.length ?? 0}件を個別判定`;
      if (includeImages) summary.textContent += ` · 画像 ${imageCount}枚`;
      if (inputValue) summary.textContent += " · 入力欄の値を判定";
      preview.textContent =
        itemError ||
        (entries
          ? entries
              .map(
                (item) =>
                  `【${item.index}件目 · ${item.text.length.toLocaleString()}文字${includeImages ? ` · 画像 ${item.images?.length ?? 0}枚` : ""}${item.truncated ? "・切り詰めあり" : ""}】\n${item.text}`,
              )
              .join("\n\n")
              .slice(0, 48000)
          : text.slice(0, 48000));
      save.disabled =
        saving ||
        !!itemError ||
        (linkedPages ? !linkCount : !inputValue && !text && !imageCount) ||
        !root.isConnected;
      parent.disabled = saving || root === document.body;
      pick.className = mode === "root" ? "active" : "";
      pick.textContent =
        mode === "root"
          ? "対象をクリック（選択を終了）"
          : "ページ上で対象を選ぶ";
      pick.setAttribute("aria-pressed", String(mode === "root"));
      pick.disabled = candidatesSelect.disabled = saving;
      if (
        ![...candidatesSelect.options].some(
          (option) => option.value === selector(root),
        )
      )
        make("option", `選択中：${label(root)}`, candidatesSelect).value =
          selector(root);
      candidatesSelect.value = selector(root);
      const expanded = new Set(
        [...tree.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
          (el) => el.dataset.path,
        ),
      );
      const focused = shadow.activeElement?.getAttribute("aria-label");
      const treeScroll = tree.scrollTop;
      tree.replaceChildren();
      let count = 0;
      function row(el: Element, holder: Element, inherited: boolean) {
        if (++count > 250 || el.matches(ignored) || !visible(el)) return;
        const details = document.createElement("details");
        details.dataset.path = selector(el);
        details.open = el === root || expanded.has(details.dataset.path);
        holder.append(details);
        const heading = make("summary", "", details);
        heading.className = inherited || excluded.has(el) ? "removed" : "";
        const include = make("label", "", heading);
        include.className = "include";
        include.onclick = (event) => event.stopPropagation();
        const checkbox = make("input", "", include);
        checkbox.type = "checkbox";
        checkbox.checked = !inherited && !excluded.has(el);
        checkbox.disabled = saving || inherited || el === root;
        checkbox.setAttribute("aria-label", `${label(el)}を含める`);
        if (inherited)
          include.title =
            "親要素の除外を解除すると、この要素も対象に戻ります。";
        checkbox.onclick = (event) => event.stopPropagation();
        checkbox.onchange = () => {
          setExcluded(el, !checkbox.checked);
        };
        include.append(checkbox.checked ? "含む" : "除外中");
        make("span", label(el), heading).className = "node-name";
        const use = make("button", "この要素以下に絞る", heading);
        use.disabled = saving || el === root;
        use.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          changeRoot(el);
        };
        const groups = childGroups(el);
        if (groups.length) {
          const processing = make("div", "", details);
          processing.className = "processing";
          const methodLabel = make("label", "判定方法 ", processing);
          const method = make("select", "", methodLabel);
          method.setAttribute("aria-label", `${label(el)}の判定方法`);
          make("option", "まとめて判定", method).value = "combined";
          make("option", "子要素を1件ずつ判定", method).value = "individual";
          const active = el === root && !!itemSelector;
          method.value = active ? "individual" : "combined";
          method.disabled =
            saving || inherited || excluded.has(el) || textEntry(el);
          const query =
            (active ? itemSelector : selectedGroups.get(el)) ?? groups[0].query;
          method.onchange = () =>
            setProcessing(
              el,
              method.value === "individual" ? query : undefined,
            );
          if (active && groups.length > 1) {
            const groupLabel = make("label", "1件分の子要素 ", processing);
            const groupSelect = make("select", "", groupLabel);
            groupSelect.setAttribute(
              "aria-label",
              `${label(el)}の1件分の子要素`,
            );
            for (const group of groups)
              make(
                "option",
                `${group.query.replace(":scope > ", "")} · ${group.count}件`,
                groupSelect,
              ).value = group.query;
            groupSelect.value = query;
            groupSelect.disabled = method.disabled;
            groupSelect.onchange = () => setProcessing(el, groupSelect.value);
          }
        }
        heading.onmouseenter = () => {
          hovered = el;
          paint();
        };
        heading.onmouseleave = () => {
          hovered = undefined;
          paint();
        };
        for (const child of el.children)
          row(child, details, inherited || excluded.has(el));
      }
      row(root, tree, false);
      if (focused)
        tree
          .querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`)
          ?.focus({ preventScroll: true });
      if (count > 250)
        make(
          "p",
          "構造は先頭250要素まで表示しています。対象を狭めるか、ページ上で選択してください。",
          tree,
        );
      tree.scrollTop = treeScroll;
      fitEditor();
      paint();
    }
    candidatesSelect.onchange = () => {
      const el = unique(candidatesSelect.value);
      if (el) changeRoot(el);
    };
    imageToggle.onchange = () => {
      includeImages = imageToggle.checked;
      if (includeImages) linkedPages = false;
      dirty = true;
      render();
    };
    linkToggle.onchange = () => {
      linkedPages = linkToggle.checked;
      if (linkedPages) includeImages = false;
      dirty = true;
      render();
    };
    linkRefresh.onclick = previewLinks;
    function setProcessing(el: Element, query: string | undefined) {
      if (query) selectedGroups.set(el, query);
      if (root !== el) changeRoot(el);
      itemSelector = query;
      promoteExclusions();
      auto = false;
      mode = undefined;
      dirty = true;
      render();
    }
    pick.onclick = () => {
      mode = mode === "root" ? undefined : "root";
      render();
    };
    parent.onclick = () => {
      if (root.parentElement && root !== document.body)
        changeRoot(root.parentElement);
    };
    reset.onclick = () => {
      root = automatic;
      auto = true;
      itemSelector = undefined;
      excluded.clear();
      includeImages = false;
      linkedPages = false;
      inputValue = false;
      specificExcluded.clear();
      sharedExclude = [];
      selectedGroups.clear();
      mode = undefined;
      dirty = true;
      status.className = "success";
      status.textContent = draftKey
        ? "本文を自動選択します。対象と基準を保存して確定してください。"
        : "新しい条件の対象を自動選択に戻します。";
      render();
    };
    function leave() {
      if (!saving && (!dirty || confirm("未保存の範囲変更を破棄しますか？")))
        cleanup();
    }
    close.onclick = leave;
    function move(event: MouseEvent) {
      if (event.composedPath().includes(host)) return;
      if (!mode && !event.altKey && !hovered) return;
      hovered =
        (mode || event.altKey) && event.target instanceof Element
          ? event.target
          : undefined;
      if (hovered?.closest(ignored)) hovered = undefined;
      if (!mode && hovered && (hovered === root || !root.contains(hovered)))
        hovered = undefined;
      paint();
    }
    function click(event: MouseEvent) {
      if (
        (!mode && !event.altKey) ||
        saving ||
        event.composedPath().includes(host) ||
        !(event.target instanceof Element)
      )
        return;
      const el = event.target;
      if (el.closest(ignored)) return;
      if (!mode && (el === root || !root.contains(el))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (mode === "root") changeRoot(el);
      else {
        // Clicking a child of an excluded element restores that excluded ancestor.
        let target = el;
        for (
          let node: Element | null = el;
          node && node !== root;
          node = node.parentElement
        )
          if (excluded.has(node)) target = node;
        setExcluded(target, !excluded.has(target));
      }
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        leave();
      }
    }
    function cleanup() {
      cancelLinkPreview();
      host.remove();
      clearInterval(watch);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", paint, true);
      window.removeEventListener("resize", paint);
      window.removeEventListener("resize", fitEditor);
      window.visualViewport?.removeEventListener("resize", fitEditor);
      window.visualViewport?.removeEventListener("scroll", fitEditor);
      if (state.__jevScopeClose === cleanup) delete state.__jevScopeClose;
    }
    const watch = setInterval(() => {
      if (location.href !== originalUrl || !host.isConnected) cleanup();
    }, 300);
    state.__jevScopeClose = cleanup;
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", paint, true);
    window.addEventListener("resize", paint);
    window.addEventListener("resize", fitEditor);
    window.visualViewport?.addEventListener("resize", fitEditor);
    window.visualViewport?.addEventListener("scroll", fitEditor);
    save.onclick = () => {
      if (saving) return;
      saving = true;
      mode = undefined;
      render();
      const config = currentScope();
      void chrome.runtime
        .sendMessage({
          type: "jev-save-content-scope",
          url: originalUrl,
          scope: config,
          ...(draftKey ? { draftKey } : {}),
        })
        .then((response) => {
          if (response?.error) throw new Error(response.error);
          dirty = false;
          cleanup();
        })
        .catch((error) => {
          saving = false;
          status.className = "error";
          status.textContent = error.message;
          render();
        });
    };
    render();
    return result();
  } catch (error) {
    // Chrome can resolve executeScript without its thrown exception/result.
    // Return failures explicitly so capture and saving cannot treat them as success.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
