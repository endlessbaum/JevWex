import { asJevError, JevError } from "../../features/jev/types";
import type { DecisionSession } from "../../inference/decision-session";
import {
  readCloudProfiles,
  readCloudSettings,
  saveCloudProfiles,
  saveCloudSettings,
  validateCloudProfile,
  validateCloudSettings,
  type CloudProfile,
  type CloudSettings,
} from "../../inference/cloud-settings";
import {
  deleteCloudKey,
  saveCloudKey,
  storedCloudStatus,
  testStoredCloud,
} from "../../extension/cloud-client";
import { CLOUD_CREDENTIALS_KEY } from "../../extension/cloud-key-store";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;

// The list contains metadata only. Extension keys stay in the service worker.
export class CloudModels {
  profiles: CloudProfile[] = [];
  loading = false;
  private editingId?: string;
  private mutating = false;
  private webKeys = new Map<string, { endpoint: string; key: string }>();
  constructor(
    private web: boolean,
    private session: DecisionSession,
    private busy: () => boolean,
    private setOperating: (value: boolean) => void,
    private notify: () => void,
    private changed: () => void,
    private action: (operation: () => void | Promise<void>) => Promise<void>,
    private showError: (error: unknown) => void,
  ) {
    if (web) {
      this.profiles = readCloudProfiles(localStorage);
      $("cloud-key-label").textContent =
        "APIキー（任意・この画面を閉じるまで）";
      $("cloud-key-hint").textContent =
        "Web版は設定一覧のみ保存します。APIキーはこの画面を閉じるまで保持します。送信先でCORSの許可が必要です。";
    } else {
      this.loading = true;
      void storedCloudStatus()
        .then((status) => {
          this.profiles = status.profiles;
          this.render();
        })
        .catch(showError)
        .finally(() => {
          this.loading = false;
          this.notify();
        });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !(CLOUD_CREDENTIALS_KEY in changes)) return;
        // Do not inspect credentials in trusted storage events.
        void storedCloudStatus()
          .then((status) => {
            this.profiles = status.profiles;
            const active = this.session.cloud;
            if (active && !this.mutating) {
              const saved = this.profiles.find(
                (p) => p.id === active.profileId,
              );
              if (
                !saved ||
                JSON.stringify(validateCloudSettings(saved)) !==
                  JSON.stringify(validateCloudSettings(active))
              ) {
                // Another settings tab changed the active connection. Finish stopping
                // before switching to local, including any pending fallback.
                void this.session
                  .stop()
                  .then(() => {
                    if (
                      this.session.cloud?.profileId === active.profileId &&
                      JSON.stringify(
                        validateCloudSettings(this.session.cloud),
                      ) === JSON.stringify(validateCloudSettings(active))
                    ) {
                      this.session.useLocal();
                      this.changed();
                    }
                  })
                  .catch(this.showError);
              }
            }
            this.notify();
          })
          .catch(showError);
      });
    }
    this.openEditor();
    $("cloud-key-save").onclick = () => void this.run(() => this.save());
    $("cloud-key-delete").onclick = () =>
      void this.run(() => this.remove(this.editingId));
    $("cloud-test").onclick = () => void this.run(() => this.test());
  }
  handle(operation: "select" | "edit" | "remove", id: string) {
    if (this.busy() || this.loading) return;
    if (operation === "edit") {
      this.openEditor(id);
      this.focusEditor();
    } else
      void this.run(() =>
        operation === "select" ? this.select(id) : this.remove(id),
      );
  }
  private async run(operation: () => void | Promise<void>) {
    await this.action(async () => {
      try {
        await operation();
      } catch (error) {
        $("cloud-status").textContent = asJevError(error).message;
        throw error;
      }
    });
  }
  private focusEditor() {
    $("cloud-editor").scrollIntoView({ block: "start" });
    $("cloud-name").focus({ preventScroll: true });
  }
  private openEditor(id?: string) {
    this.editingId = id;
    const profile = this.profiles.find((p) => p.id === id);
    const settings = profile ?? readCloudSettings(localStorage, "jev");
    $<HTMLInputElement>("cloud-name").value = profile?.name ?? "";
    $<HTMLInputElement>("cloud-endpoint").value = settings.endpoint;
    $<HTMLInputElement>("cloud-model").value = settings.model;
    $<HTMLInputElement>("cloud-timeout").value = String(
      settings.timeoutSeconds,
    );
    $<HTMLInputElement>("cloud-fallback").checked = settings.fallback;
    $<HTMLInputElement>("cloud-key").value = "";
    $("cloud-editing").textContent = profile
      ? `設定を変更：${profile.name}`
      : "新しいAPIを追加";
    this.render();
  }
  private formSettings() {
    return validateCloudSettings({
      provider: "jev",
      endpoint: value("cloud-endpoint"),
      model: value("cloud-model"),
      timeoutSeconds: Number(value("cloud-timeout")),
      fallback: $<HTMLInputElement>("cloud-fallback").checked,
    });
  }
  private permission(settings: CloudSettings) {
    return this.web
      ? Promise.resolve(true)
      : chrome.permissions.request({
          origins: [
            `${new URL(settings.endpoint).protocol}//${new URL(settings.endpoint).hostname}/*`,
          ],
        });
  }
  private checkFallback(settings: CloudSettings) {
    if (settings.fallback && !this.session.local.loaded)
      throw new JevError(
        "MODEL_NOT_LOADED",
        "フォールバック用のローカルモデルを先に読み込んでください。",
      );
  }
  private webKey(profile: CloudProfile) {
    const current = this.webKeys.get(profile.id);
    return current?.endpoint === profile.endpoint ? current.key : "";
  }
  private activate(profile: CloudProfile) {
    this.checkFallback(profile);
    this.session.useCloud({
      ...profile,
      profileId: profile.id,
      apiKey: this.web ? this.webKey(profile) : "",
    });
    this.changed();
  }
  private async save() {
    if (this.busy() || this.loading) return;
    const next = this.formSettings();
    this.checkFallback(next);
    const profile = validateCloudProfile({
      ...next,
      id: this.editingId ?? crypto.randomUUID(),
      name: value("cloud-name").trim() || next.model,
    });
    // Start permission request inside the click gesture, before awaiting anything.
    const permission = this.permission(next);
    const key = value("cloud-key");
    this.mutating = true;
    this.setOperating(true);
    try {
      if (!(await permission))
        throw new JevError("API_ERROR", "API送信先のアクセス許可が必要です。");
      if (this.web) {
        const old = this.webKeys.get(profile.id);
        if (old?.key && old.endpoint !== next.endpoint && !key.trim())
          throw new JevError(
            "API_KEY_NOT_CONFIGURED",
            "送信先を変更する場合はキーを再入力してください。",
          );
        const profiles = this.profiles.filter((p) => p.id !== profile.id);
        const index = this.profiles.findIndex((p) => p.id === profile.id);
        profiles.splice(index < 0 ? profiles.length : index, 0, profile);
        saveCloudProfiles(localStorage, profiles);
        this.profiles = profiles;
        this.webKeys.set(profile.id, {
          endpoint: next.endpoint,
          key: key.trim() || (old?.endpoint === next.endpoint ? old.key : ""),
        });
      } else {
        const status = await saveCloudKey(next, key, profile.id, profile.name);
        this.profiles = status.profiles;
      }
      saveCloudSettings(localStorage, next);
      this.activate(profile);
      this.openEditor();
      $("cloud-status").textContent =
        `「${profile.name}」を保存し、使用中にしました。次の判定から送信します。`;
    } finally {
      this.mutating = false;
      this.setOperating(false);
      this.notify();
    }
  }
  private async select(id: string) {
    if (this.busy() || this.loading) return;
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile)
      throw new JevError("INVALID_REQUEST", "このAPI設定は削除されています。");
    this.checkFallback(profile);
    const permission = this.permission(profile);
    this.setOperating(true);
    try {
      if (!(await permission))
        throw new JevError("API_ERROR", "API送信先のアクセス許可が必要です。");
      if (!this.web) {
        const status = await storedCloudStatus(id);
        if (!status.configured)
          throw new JevError(
            "API_KEY_NOT_CONFIGURED",
            "このAPI設定は削除されています。",
          );
        this.profiles = status.profiles;
        this.activate(this.profiles.find((p) => p.id === id)!);
      } else this.activate(profile);
      this.openEditor(id);
      $("cloud-status").textContent = `「${profile.name}」を選択しました。`;
    } finally {
      this.setOperating(false);
      this.notify();
    }
  }
  private async remove(id?: string) {
    if (!id || this.busy() || this.loading) return;
    this.mutating = true;
    this.setOperating(true);
    try {
      if (this.web) {
        const remaining = this.profiles.filter((p) => p.id !== id);
        saveCloudProfiles(localStorage, remaining);
        this.profiles = remaining;
        this.webKeys.delete(id);
      } else this.profiles = (await deleteCloudKey(id)).profiles;
      if (this.session.cloud?.profileId === id) {
        this.session.useLocal();
        this.changed();
      }
      if (this.editingId === id) this.openEditor();
      $("cloud-status").textContent = "API設定とキーを削除しました。";
    } finally {
      this.mutating = false;
      this.setOperating(false);
      this.notify();
    }
  }
  private async test() {
    if (this.busy() || this.loading) return;
    const id = this.editingId ?? this.session.cloud?.profileId;
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile)
      throw new JevError(
        "API_KEY_NOT_CONFIGURED",
        "APIキーと設定を保存してください。",
      );
    this.setOperating(true);
    try {
      $("cloud-status").textContent =
        "保存済みAPI設定で短い判定を1回送信しています…";
      if (!this.web) await testStoredCloud(profile, id);
      else {
        const { evaluateCloud } = await import(
          "../../inference/cloud-evaluate"
        );
        await evaluateCloud(
          { ...profile, apiKey: this.webKey(profile) },
          {
            state: "Connection test",
            questions: {
              connection: {
                type: "noul",
                instructions: "Is this a connection test?",
              },
            },
          },
          {
            model: `cloud:jev:${profile.id}`,
            generation: 0,
            load_ms: 0,
            threads: 0,
            context: 0,
          },
        );
      }
      $("cloud-status").textContent =
        "接続成功。保存済み設定で判定の応答を確認しました。";
    } finally {
      this.setOperating(false);
      this.notify();
    }
  }
  render() {
    const busy = this.loading || this.busy();
    for (const id of ["cloud-key-save", "cloud-test", "cloud-key-delete"])
      $<HTMLButtonElement>(id).disabled =
        busy || (id === "cloud-key-delete" && !this.editingId);
    $("cloud-key-delete").hidden = !this.editingId;
    for (const id of [
      "cloud-name",
      "cloud-endpoint",
      "cloud-model",
      "cloud-key",
      "cloud-timeout",
      "cloud-fallback",
    ])
      $<HTMLInputElement>(id).disabled = busy;
    const profile = this.profiles.find((p) => p.id === this.editingId);
    $("cloud-key-state").textContent =
      profile && (!this.web || this.webKey(profile))
        ? `APIキー設定済み（${new URL(profile.endpoint).origin}）`
        : "APIキー未設定";
    const cloud = this.session.cloud;
    $("cloud-active").textContent = cloud
      ? `現在：JEV互換API / ${this.profiles.find((p) => p.id === cloud.profileId)?.name ?? cloud.model} / ${cloud.model} / ${new URL(cloud.endpoint).origin}`
      : "現在：ローカルモデル（既定）";
  }
}
