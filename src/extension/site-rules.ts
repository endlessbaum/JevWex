import { buildInput, type CriterionDraft } from "../pages/jev/criteria-editor";
import { scopeKey, validateScope, type ContentScope } from "./content-scope";

export type UrlScope = "exact" | "subtree" | "origin";
export interface SiteRule {
  id: string;
  name: string;
  url: string;
  scope: UrlScope;
  enabled: boolean;
  criteria: CriterionDraft[];
  contentScope?: ContentScope;
}
export const RULE_PREFIX = "jev-site-rule:";
export const scopeNames = {
  exact: "このURLのみ",
  subtree: "配下のページ",
  origin: "サイト全体",
};

export function normalizeUrl(value: string, scope: UrlScope = "exact"): string {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "http / https のURLを入力してください（認証情報は含められません）。",
    );
  url.hash = "";
  if (scope === "origin") return url.origin;
  if (scope === "subtree") {
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }
  return url.href;
}

export function matchesUrl(
  rule: SiteRule,
  value: string,
  includeDisabled = false,
): boolean {
  if (!includeDisabled && !rule.enabled) return false;
  try {
    const target = new URL(normalizeUrl(value));
    const base = new URL(normalizeUrl(rule.url, rule.scope));
    if (target.origin !== base.origin) return false;
    if (rule.scope === "origin") return true;
    if (rule.scope === "exact") return target.href === base.href;
    const path = base.pathname.replace(/\/+$/, "");
    return target.pathname === path || target.pathname.startsWith(path + "/");
  } catch {
    return false;
  }
}

export function matchingRules(
  rules: SiteRule[],
  url: string,
  includeDisabled = false,
): SiteRule[] {
  const rank = { exact: 3, subtree: 2, origin: 1 };
  return rules
    .filter((rule) => matchesUrl(rule, url, includeDisabled))
    .sort(
      (a, b) =>
        rank[b.scope] - rank[a.scope] ||
        b.url.length - a.url.length ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

export function validateRule(value: unknown): SiteRule {
  if (!value || typeof value !== "object")
    throw new Error("保存条件の形式が正しくありません。");
  const r = value as SiteRule;
  if (
    typeof r.id !== "string" ||
    !/^[\w-]{1,80}$/.test(r.id) ||
    typeof r.name !== "string" ||
    !r.name.trim() ||
    r.name.length > 120 ||
    typeof r.url !== "string" ||
    r.url.length > 4096 ||
    !["exact", "subtree", "origin"].includes(r.scope) ||
    typeof r.enabled !== "boolean" ||
    !Array.isArray(r.criteria)
  )
    throw new Error("条件名・URL・適用範囲を確認してください。");
  for (const c of r.criteria) {
    if (
      !c ||
      typeof c.id !== "string" ||
      typeof c.alias !== "string" ||
      typeof c.instructions !== "string" ||
      !["choice", "score", "noul"].includes(c.type) ||
      !Array.isArray(c.labels) ||
      c.labels.some(
        (l) =>
          !l ||
          typeof l.label !== "string" ||
          typeof l.description !== "string",
      )
    )
      throw new Error("判定基準の形式が正しくありません。");
  }
  buildInput("保存条件の検証", r.criteria);
  return {
    id: r.id,
    name: r.name.trim(),
    url: normalizeUrl(r.url, r.scope),
    scope: r.scope,
    enabled: r.enabled,
    criteria: structuredClone(r.criteria),
    ...(r.contentScope !== undefined
      ? { contentScope: validateScope(r.contentScope) }
      : {}),
  };
}

// Extension pages and the service worker share this lock. Migration and toggles
// must not overwrite a target or criteria saved concurrently in another view.
async function withRules<T>(action: () => Promise<T>): Promise<T> {
  return await (globalThis.navigator?.locks
    ? navigator.locks.request("jev-site-rules", action)
    : action());
}
async function readAndMigrate(): Promise<SiteRule[]> {
  const data = await chrome.storage.local.get(null);
  const updates: Record<string, SiteRule> = {};
  const rules = Object.entries(data)
    .filter(([key]) => key.startsWith(RULE_PREFIX))
    .map(([key, value]) => {
      const rule = validateRule(value);
      if (!rule.contentScope) {
        rule.contentScope = validateScope(
          data[scopeKey(rule.url)] ?? { root: null, exclude: [] },
        );
        updates[key] = rule;
      }
      return rule;
    });
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  return rules;
}
export function readRules(): Promise<SiteRule[]> {
  return withRules(readAndMigrate);
}
export function saveRule(rule: SiteRule, expected?: SiteRule) {
  return withRules(async () => {
    const clean = validateRule(rule);
    const current = await readAndMigrate();
    if (
      expected &&
      JSON.stringify(current.find((r) => r.id === clean.id)) !==
        JSON.stringify(expected)
    )
      throw new Error(
        "この条件は別の画面で変更・削除されています。開き直して確認してください。",
      );
    if (!clean.contentScope) {
      const data = await chrome.storage.local.get(scopeKey(clean.url));
      clean.contentScope = validateScope(
        data[scopeKey(clean.url)] ?? { root: null, exclude: [] },
      );
    }
    await chrome.storage.local.set({ [RULE_PREFIX + clean.id]: clean });
    return clean;
  });
}
export function deleteRule(id: string) {
  return withRules(() => chrome.storage.local.remove(RULE_PREFIX + id));
}
export function setRuleEnabled(id: string, enabled: boolean) {
  return withRules(async () => {
    const rule = (await readAndMigrate()).find((rule) => rule.id === id);
    if (!rule)
      throw new Error("この条件は削除されています。一覧を確認してください。");
    const clean = { ...rule, enabled };
    await chrome.storage.local.set({ [RULE_PREFIX + id]: clean });
    return clean;
  });
}
