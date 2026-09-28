export const LAST_MODEL_STORAGE_KEY = "jev.last-model.v1";
export interface LastModel {
  id: string;
  label: string;
}

export function readLastModel(
  storage: Pick<Storage, "getItem">,
): LastModel | undefined {
  try {
    const raw = storage.getItem(LAST_MODEL_STORAGE_KEY);
    if (!raw) return;
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value.id !== "string" ||
      !/^(cache:|local:).+/.test(value.id) ||
      value.id.length > 16384 ||
      typeof value.label !== "string" ||
      !value.label.trim() ||
      value.label.length > 4096
    )
      return;
    return { id: value.id, label: value.label };
  } catch {
    return;
  }
}

export function saveLastModel(
  storage: Pick<Storage, "setItem">,
  model: LastModel,
): boolean {
  try {
    storage.setItem(
      LAST_MODEL_STORAGE_KEY,
      JSON.stringify({ id: model.id, label: model.label }),
    );
    return true;
  } catch {
    return false;
  }
}
