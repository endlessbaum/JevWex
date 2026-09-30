import { JevError } from "../features/jev/types";

export const RUNTIME_SETTINGS_KEY = "jev.runtime-settings.v1";
export interface RuntimeSettings {
  startup: "small" | "last" | "none";
  maxAutoLoadGiB: number;
  fallbackModel: string;
  loadSeconds: number;
  responseSeconds: number;
}
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  startup: "small",
  maxAutoLoadGiB: 4,
  fallbackModel: "",
  loadSeconds: 180,
  responseSeconds: 240,
};
export function validateRuntimeSettings(value: unknown): RuntimeSettings {
  const x = value as RuntimeSettings | null;
  if (
    !x ||
    !["small", "last", "none"].includes(x.startup) ||
    !Number.isFinite(x.maxAutoLoadGiB) ||
    x.maxAutoLoadGiB < 0.1 ||
    x.maxAutoLoadGiB > 128 ||
    typeof x.fallbackModel !== "string" ||
    x.fallbackModel.length > 16384 ||
    (x.fallbackModel !== "" && !x.fallbackModel.startsWith("cache:")) ||
    ![x.loadSeconds, x.responseSeconds].every(
      (n) => Number.isInteger(n) && n >= 1 && n <= 3600,
    )
  )
    throw new JevError(
      "INVALID_REQUEST",
      "自動読み込みの上限は0.1〜128 GiB、待ち時間は1〜3,600秒で指定してください。",
    );
  return {
    startup: x.startup,
    maxAutoLoadGiB: x.maxAutoLoadGiB,
    fallbackModel: x.fallbackModel,
    loadSeconds: x.loadSeconds,
    responseSeconds: x.responseSeconds,
  };
}
export function readRuntimeSettings(
  storage: Pick<Storage, "getItem">,
): RuntimeSettings {
  try {
    const raw = storage.getItem(RUNTIME_SETTINGS_KEY);
    return raw
      ? validateRuntimeSettings(JSON.parse(raw))
      : { ...DEFAULT_RUNTIME_SETTINGS };
  } catch {
    return { ...DEFAULT_RUNTIME_SETTINGS };
  }
}
interface StartupModel {
  id: string;
  size: number;
  label: string;
}
export function chooseStartupModel(
  settings: RuntimeSettings,
  lastId: string | undefined,
  models: readonly StartupModel[],
) {
  if (settings.startup === "none")
    return {
      message: "自動読み込みはオフです。モデル管理から手動で読み込めます。",
    };
  if (!lastId) return { message: "モデル管理からモデルを選んでください。" };
  const cached = models.filter((m) => m.id.startsWith("cache:"));
  const last = cached.find((m) => m.id === lastId);
  if (settings.startup === "last")
    return last
      ? { model: last, message: "前回のモデルを読み込みます。" }
      : {
          message:
            "前回のモデルが保存されていません。モデル管理から追加してください。",
        };
  const limit = settings.maxAutoLoadGiB * 1024 ** 3;
  const eligible = cached.filter(
    (m) => Number.isFinite(m.size) && m.size > 0 && m.size <= limit,
  );
  if (last && eligible.includes(last))
    return { model: last, message: "前回のモデルを読み込みます。" };
  const fallback = settings.fallbackModel
    ? eligible.find((m) => m.id === settings.fallbackModel)
    : eligible.sort((a, b) => a.size - b.size || a.id.localeCompare(b.id))[0];
  const reason = last
    ? `前回のモデルは${settings.maxAutoLoadGiB} GiB以下と確認できないため、自動読み込みをスキップしました。`
    : "前回のモデルが保存されていません。";
  return fallback
    ? {
        model: fallback,
        message: `${reason} 代わりに「${fallback.label}」を使います。`,
      }
    : {
        message: `${reason} 条件に合う代替モデルがないため、手動でモデルを選択してください。`,
      };
}
