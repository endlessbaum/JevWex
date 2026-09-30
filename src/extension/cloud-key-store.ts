import { JevError, type JevInput } from "../features/jev/types";
import { validateRequest } from "../features/jev/validate";
import { evaluateCloud } from "../inference/cloud-evaluate";
import {
  validateCloudSettings,
  validateCloudProfile,
  validateProfileId,
  type CloudProfile,
  type CloudSettings,
} from "../inference/cloud-settings";

export const CLOUD_CREDENTIALS_KEY = "jev-cloud-credentials:v1";
type KeyStorage = Pick<
  chrome.storage.StorageArea,
  "get" | "set" | "remove" | "setAccessLevel"
>;
export interface CloudKeyStatus {
  configured: boolean;
  settings?: CloudSettings;
  profileId?: string;
  profiles: CloudProfile[];
}
type StoredProfile = CloudProfile & { apiKey: string };
export function normalizeApiKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 8192 ||
    /[\u0000-\u001f\u007f]/.test(value.trim())
  )
    throw new JevError(
      "INVALID_REQUEST",
      "空でないAPIキーを入力してください（最大8,192文字・改行不可）。",
    );
  return value.trim();
}

// Only the service worker instantiates this store. No method returns credentials.
export class CloudKeyStore {
  private ready: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: KeyStorage,
    private permission: (endpoint: string) => Promise<boolean>,
    private fetcher: typeof fetch = globalThis.fetch,
  ) {
    // Run on every worker activation and await before any key read/write.
    this.ready = Promise.resolve(
      storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    ).catch(() => {
      throw new JevError(
        "API_ERROR",
        "APIキー保存領域のアクセス制限を設定できませんでした。",
      );
    });
    void this.ready.catch(() => {});
  }
  private async read(): Promise<StoredProfile[]> {
    await this.ready;
    const value = (await this.storage.get(CLOUD_CREDENTIALS_KEY))[
      CLOUD_CREDENTIALS_KEY
    ];
    if (!value) return [];
    try {
      if (value.version === 2 && Array.isArray(value.profiles)) {
        const profiles: StoredProfile[] = value.profiles.map(
          (entry: unknown) => ({
            ...validateCloudProfile(entry),
            apiKey: normalizeApiKey((entry as StoredProfile).apiKey),
          }),
        );
        if (
          profiles.length > 100 ||
          new Set(profiles.map((p) => p.id)).size !== profiles.length
        )
          return [];
        return profiles;
      }
      // Existing installations keep their key and settings without re-entry.
      return [
        {
          ...validateCloudSettings(value),
          id: "legacy",
          name: value.model.trim(),
          apiKey: normalizeApiKey(value.apiKey),
        },
      ];
    } catch {
      return [];
    }
  }
  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => {});
    return result;
  }
  private summary(profiles: StoredProfile[], id?: string): CloudKeyStatus {
    const current =
      id === undefined ? profiles[0] : profiles.find((p) => p.id === id);
    return {
      configured: !!current,
      ...(current
        ? { settings: validateCloudSettings(current), profileId: current.id }
        : {}),
      profiles: profiles.map(validateCloudProfile),
    };
  }
  async status(id?: string): Promise<CloudKeyStatus> {
    if (id !== undefined) validateProfileId(id);
    await this.writes;
    return this.summary(await this.read(), id);
  }
  save(
    value: unknown,
    key?: unknown,
    id?: string,
    name?: string,
  ): Promise<CloudKeyStatus> {
    return this.write(async () => {
      const settings = validateCloudSettings(value);
      const profiles = await this.read();
      const target = id ?? profiles[0]?.id ?? "legacy";
      const profile = validateCloudProfile({
        ...settings,
        id: target,
        name:
          name ?? profiles.find((p) => p.id === target)?.name ?? settings.model,
      });
      const current = profiles.find((p) => p.id === profile.id);
      if (!current && profiles.length >= 100)
        throw new JevError(
          "INVALID_REQUEST",
          "API設定は最大100件まで保存できます。",
        );
      const apiKey =
        typeof key === "string" && !key.trim()
          ? undefined
          : key === undefined
            ? undefined
            : normalizeApiKey(key);
      if (!apiKey && (!current || current.endpoint !== settings.endpoint))
        throw new JevError(
          "API_KEY_NOT_CONFIGURED",
          "この送信先のAPIキーを設定してください。送信先を変更する場合はキーを再入力してください。",
        );
      const next = { ...profile, apiKey: apiKey ?? current!.apiKey };
      const index = profiles.findIndex((p) => p.id === profile.id);
      if (index < 0) profiles.push(next);
      else profiles[index] = next;
      await this.storage.set({
        [CLOUD_CREDENTIALS_KEY]: { version: 2, profiles },
      });
      return this.summary(profiles, profile.id);
    });
  }
  remove(id?: string): Promise<CloudKeyStatus> {
    return this.write(async () => {
      await this.ready;
      const profiles = await this.read();
      const target = id === undefined ? profiles[0]?.id : validateProfileId(id);
      const remaining = profiles.filter((p) => p.id !== target);
      if (remaining.length)
        await this.storage.set({
          [CLOUD_CREDENTIALS_KEY]: { version: 2, profiles: remaining },
        });
      else await this.storage.remove(CLOUD_CREDENTIALS_KEY);
      return this.summary(remaining);
    });
  }
  async evaluate(
    value: unknown,
    expected: unknown,
    signal: AbortSignal,
    id?: string,
  ) {
    const input: JevInput = structuredClone(validateRequest(value));
    await this.writes;
    if (id !== undefined) validateProfileId(id);
    const profiles = await this.read();
    const connection =
      id === undefined ? profiles[0] : profiles.find((p) => p.id === id);
    signal.throwIfAborted();
    if (!connection)
      throw new JevError(
        "API_KEY_NOT_CONFIGURED",
        "APIキーを設定してください。",
      );
    if (
      JSON.stringify(validateCloudSettings(expected)) !==
      JSON.stringify(validateCloudSettings(connection))
    )
      throw new JevError(
        "INVALID_REQUEST",
        "保存済みAPI設定が変更されています。モデル管理から選び直してください。",
      );
    if (!(await this.permission(connection.endpoint)))
      throw new JevError("API_ERROR", "API送信先のアクセス許可が必要です。");
    signal.throwIfAborted();
    const fetcher: typeof fetch = async (url, init) => {
      let response: Response;
      try {
        response = await this.fetcher.call(globalThis, url, init);
      } catch {
        throw new JevError("NETWORK_ERROR", "APIへ接続できませんでした。");
      }
      if (response.status === 401 || response.status === 403)
        throw new JevError(
          "AUTHENTICATION_FAILED",
          "APIキーを確認してください。",
        );
      if (response.status === 429)
        throw new JevError(
          "RATE_LIMITED",
          "APIの利用上限またはレート制限に達しています。",
        );
      if (!response.ok)
        throw new JevError(
          "API_ERROR",
          `APIがHTTP ${response.status}を返しました。`,
        );
      return response;
    };
    const result = await evaluateCloud(
      connection,
      input,
      {
        model: `cloud:${connection.provider}:${connection.model}`,
        generation: 0,
        load_ms: 0,
        threads: 0,
        context: 0,
      },
      signal,
      fetcher,
    );
    // A misconfigured provider may echo request headers even in JSON fields.
    if (JSON.stringify(result).includes(connection.apiKey))
      throw new JevError(
        "INVALID_OUTPUT",
        "APIの回答に認証情報が含まれているため表示できません。",
      );
    return result;
  }
}

export function isCloudSettingsSender(
  sender: chrome.runtime.MessageSender,
  id: string,
  getUrl: (path: string) => string,
) {
  return (
    sender.id === id &&
    (sender.frameId === undefined || sender.frameId === 0) &&
    ["index.html", "jev.html"].some(
      (path) => sender.url?.split(/[?#]/)[0] === getUrl(path),
    )
  );
}
