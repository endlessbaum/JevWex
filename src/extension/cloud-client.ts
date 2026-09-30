import {
  JevError,
  type ErrorCode,
  type JevInput,
  type LocalEvaluation,
} from "../features/jev/types";
import type { CloudSettings } from "../inference/cloud-settings";
import type { evaluateCloud } from "../inference/cloud-evaluate";
import type { CloudKeyStatus } from "./cloud-key-store";

export async function cloudMessage<T>(
  message: Record<string, unknown>,
): Promise<T> {
  let reply;
  try {
    reply = await chrome.runtime.sendMessage(message);
  } catch {
    throw new JevError(
      "API_ERROR",
      "API設定の処理に接続できません。拡張を読み込み直してください。",
    );
  }
  if (!reply?.ok)
    throw new JevError(
      (reply?.code ?? "API_ERROR") as ErrorCode,
      reply?.error ?? "API処理に失敗しました。",
    );
  return reply.value as T;
}
export const storedCloudStatus = (profileId?: string) =>
  cloudMessage<CloudKeyStatus>({ type: "jev-cloud-status", profileId });
export const saveCloudKey = (
  settings: CloudSettings,
  apiKey: string,
  profileId?: string,
  name?: string,
) =>
  cloudMessage<CloudKeyStatus>({
    type: "jev-cloud-save",
    settings,
    apiKey,
    profileId,
    name,
  });
export const deleteCloudKey = (profileId?: string) =>
  cloudMessage<CloudKeyStatus>({ type: "jev-cloud-delete", profileId });
export const evaluateStoredCloud: typeof evaluateCloud = async (
  connection,
  input,
  snapshot,
  signal,
) => {
  const requestId = crypto.randomUUID();
  const abort = () => {
    void chrome.runtime
      .sendMessage({ type: "jev-cloud-cancel", requestId })
      .catch(() => {});
  };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const pending = cloudMessage<LocalEvaluation>({
      type: "jev-cloud-evaluate",
      requestId,
      profileId: connection.profileId,
      settings: {
        provider: connection.provider,
        endpoint: connection.endpoint,
        model: connection.model,
        timeoutSeconds: connection.timeoutSeconds,
        fallback: connection.fallback,
      },
      input,
    });
    if (signal?.aborted) abort();
    const result = await pending;
    signal?.throwIfAborted();
    result.diagnostics.generation = snapshot.generation;
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
};
export async function testStoredCloud(
  settings: CloudSettings,
  profileId?: string,
) {
  const input: JevInput = {
    state: "Connection test",
    questions: {
      connection: { type: "noul", instructions: "Is this a connection test?" },
    },
  };
  return cloudMessage<LocalEvaluation>({
    type: "jev-cloud-evaluate",
    requestId: crypto.randomUUID(),
    profileId,
    settings,
    input,
  });
}
