import { JevError } from "../features/jev/types";
import { record } from "../features/jev/validate";

export type CloudProvider = "jev";
export interface CloudSettings {
  provider: CloudProvider;
  endpoint: string;
  model: string;
  timeoutSeconds: number;
  fallback: boolean;
}
export interface CloudConnection extends CloudSettings {
  apiKey: string;
  profileId?: string;
}
export interface CloudProfile extends CloudSettings {
  id: string;
  name: string;
}
export const CLOUD_PROFILES_KEY = "jevwex.cloud.profiles.v1";
export function validateProfileId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,80}$/.test(value))
    throw new JevError(
      "INVALID_REQUEST",
      "API設定の識別情報が正しくありません。",
    );
  return value;
}
export function validateCloudProfile(value: unknown): CloudProfile {
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.trim().length > 100
  )
    throw new JevError(
      "INVALID_REQUEST",
      "設定名を1〜100文字で入力してください。",
    );
  return {
    ...validateCloudSettings(value),
    id: validateProfileId(value.id),
    name: value.name.trim(),
  };
}
export function readCloudProfiles(
  storage: Pick<Storage, "getItem">,
): CloudProfile[] {
  try {
    const raw: unknown = JSON.parse(
      storage.getItem(CLOUD_PROFILES_KEY) ?? "[]",
    );
    if (Array.isArray(raw)) {
      const profiles = raw.map(validateCloudProfile);
      if (
        profiles.length <= 100 &&
        new Set(profiles.map((p) => p.id)).size === profiles.length
      )
        return profiles;
    }
  } catch {
    /* A corrupt list must never enable cloud inference. */
  }
  return [];
}
export function saveCloudProfiles(
  storage: Pick<Storage, "setItem">,
  values: CloudProfile[],
) {
  const profiles = values.map(validateCloudProfile);
  if (
    profiles.length > 100 ||
    new Set(profiles.map((p) => p.id)).size !== profiles.length
  )
    throw new JevError(
      "INVALID_REQUEST",
      "API設定は重複なしで最大100件まで保存できます。",
    );
  // Whitelist metadata only, even if the caller passed connection objects.
  storage.setItem(CLOUD_PROFILES_KEY, JSON.stringify(profiles));
}
export const CLOUD_SETTINGS_KEY = "jevwex.cloud.v1";
export const CLOUD_DEFAULTS: Record<CloudProvider, CloudSettings> = {
  jev: {
    provider: "jev",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    timeoutSeconds: 60,
    fallback: true,
  },
};
export function validateCloudSettings(value: unknown): CloudSettings {
  const invalid = (): never => {
    throw new JevError(
      "INVALID_REQUEST",
      "APIの種類・送信先・モデルID・待ち時間（1〜600秒）を確認してください。",
    );
  };
  if (
    !record(value) ||
    !["jev"].includes(String(value.provider)) ||
    typeof value.endpoint !== "string" ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    typeof value.timeoutSeconds !== "number" ||
    !Number.isInteger(value.timeoutSeconds) ||
    value.timeoutSeconds < 1 ||
    value.timeoutSeconds > 600 ||
    typeof value.fallback !== "boolean"
  )
    return invalid();
  let url: URL;
  try {
    url = new URL(value.endpoint.trim());
  } catch {
    return invalid();
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return invalid();
  return {
    provider: value.provider as CloudProvider,
    endpoint: url.href,
    model: value.model.trim(),
    timeoutSeconds: value.timeoutSeconds,
    fallback: value.fallback,
  };
}
export function readCloudSettings(
  storage: Pick<Storage, "getItem">,
  provider: CloudProvider,
): CloudSettings {
  try {
    const all: unknown = JSON.parse(
      storage.getItem(CLOUD_SETTINGS_KEY) ?? "{}",
    );
    if (record(all)) {
      const settings = validateCloudSettings(all[provider]);
      if (settings.provider === provider) return settings;
    }
  } catch {
    /* Invalid or inaccessible storage must never enable a cloud provider. */
  }
  return { ...CLOUD_DEFAULTS[provider] };
}
export function saveCloudSettings(
  storage: Pick<Storage, "getItem" | "setItem">,
  value: CloudSettings,
) {
  // Rebuild a whitelist: neither credentials nor the active provider are persisted.
  const settings = validateCloudSettings(value);
  const all = Object.fromEntries(
    (["jev"] as const).map((p) => [p, readCloudSettings(storage, p)]),
  );
  all[settings.provider] = settings;
  storage.setItem(CLOUD_SETTINGS_KEY, JSON.stringify(all));
}
