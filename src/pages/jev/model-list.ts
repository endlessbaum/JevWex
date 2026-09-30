import type { ModelEntry } from "../../inference/model-session";
import type { CloudProfile } from "../../inference/cloud-settings";

interface ListState {
  loadedId?: string;
  loadingId?: string;
  deletingId?: string;
  phase: string;
  busy: boolean;
  canLoad: boolean;
  standby?: boolean;
}
export class ModelList {
  constructor(
    private container: HTMLElement,
    private onAction: (
      action: "load" | "unload" | "remove",
      id: string,
    ) => void,
    private onCloudAction?: (
      action: "select" | "edit" | "remove",
      id: string,
    ) => void,
  ) {}
  render(models: Iterable<ModelEntry>, state: ListState) {
    const existing = new Map(
      Array.from(this.container.children)
        .filter((row) => (row as HTMLElement).dataset.modelId !== undefined)
        .map((row) => [
          (row as HTMLElement).dataset.modelId,
          row as HTMLElement,
        ]),
    );
    const entries = [...models];
    for (const entry of entries) {
      let row = existing.get(entry.id);
      existing.delete(entry.id);
      if (!row) {
        row = document.createElement("li");
        row.className = "model-list-item";
        row.dataset.modelId = entry.id;
        row.innerHTML =
          '<div class="model-list-heading"><h3></h3><span class="model-state"></span></div><p class="model-details muted"></p><p class="model-source muted"></p><div class="row model-actions"></div>';
        for (const action of ["load", "unload", "remove"] as const) {
          const button = document.createElement("button");
          button.dataset.modelAction = action;
          button.className =
            action === "load"
              ? "primary"
              : action === "remove"
                ? "secondary danger"
                : "secondary";
          button.onclick = () => this.onAction(action, entry.id);
          row.querySelector(".model-actions")!.append(button);
        }
        this.container.append(row);
      }
      const local = Array.isArray(entry.source);
      const active = entry.id === state.loadedId;
      const loading = entry.id === state.loadingId;
      const deleting = entry.id === state.deletingId;
      row.dataset.active = String(active);
      row.querySelector("h3")!.textContent = entry.label;
      const status = row.querySelector<HTMLElement>(".model-state")!;
      status.textContent = deleting
        ? "削除中"
        : loading
          ? "読み込み中"
          : active
            ? state.standby
              ? "ローカル待機"
              : state.phase === "running"
                ? "使用中・判定中"
                : state.phase === "stopping"
                  ? "使用中・中止処理中"
                  : "使用中"
            : "未使用";
      const size =
        entry.size < 0
          ? "サイズ不明"
          : entry.size >= 1024 ** 3
            ? `${(entry.size / 1024 ** 3).toFixed(2)} GiB`
            : `${(entry.size / 1048576).toFixed(1)} MiB`;
      row.querySelector(".model-details")!.textContent =
        `${size} · ${local ? "端末から追加（元ファイルは削除しません）" : "ブラウザに保存済み"}`;
      row.querySelector(".model-source")!.textContent = Array.isArray(
        entry.source,
      )
        ? ""
        : entry.source.url;
      for (const action of ["load", "unload", "remove"] as const) {
        const button = row.querySelector<HTMLButtonElement>(
          `[data-model-action="${action}"]`,
        )!;
        button.textContent =
          action === "load"
            ? active && state.standby
              ? "使用する"
              : "読み込む"
            : action === "unload"
              ? "使用を終了"
              : local
                ? "一覧から削除"
                : "削除";
        button.setAttribute(
          "aria-label",
          `${entry.label}：${button.textContent}`,
        );
        button.hidden =
          action === "load"
            ? active && !state.standby
            : action === "unload"
              ? !active
              : false;
        button.disabled = state.busy || (action === "load" && !state.canLoad);
      }
    }
    for (const row of existing.values()) row.remove();
    this.container.hidden = entries.length === 0;
  }
  renderCloud(
    profiles: CloudProfile[],
    activeId: string | undefined,
    busy: boolean,
  ) {
    const existing = new Map(
      Array.from(
        this.container.querySelectorAll<HTMLElement>("[data-cloud-id]"),
      ).map((row) => [row.dataset.cloudId, row]),
    );
    for (const profile of profiles) {
      let row = existing.get(profile.id);
      existing.delete(profile.id);
      if (!row) {
        row = document.createElement("li");
        row.className = "model-list-item";
        row.dataset.cloudId = profile.id;
        row.innerHTML =
          '<div class="model-list-heading"><h3></h3><span class="model-state"></span></div><p class="model-details muted"></p><p class="model-source muted"></p><div class="row model-actions"></div>';
        for (const action of ["select", "edit", "remove"] as const) {
          const button = document.createElement("button");
          button.dataset.cloudAction = action;
          button.className =
            action === "select"
              ? "primary"
              : action === "remove"
                ? "secondary danger"
                : "secondary";
          button.textContent =
            action === "select"
              ? "使用する"
              : action === "edit"
                ? "設定を変更"
                : "削除";
          button.onclick = () => this.onCloudAction?.(action, profile.id);
          row.querySelector(".model-actions")!.append(button);
        }
        this.container.append(row);
      }
      const active = activeId === profile.id;
      row.dataset.active = String(active);
      row.querySelector("h3")!.textContent = profile.name;
      row.querySelector(".model-state")!.textContent = active
        ? "使用中"
        : "未使用";
      row.querySelector(".model-details")!.textContent =
        `JEV互換API · ${profile.model} · ${profile.fallback ? "ローカルへフォールバック" : "フォールバックなし"}`;
      row.querySelector(".model-source")!.textContent = profile.endpoint;
      for (const action of ["select", "edit", "remove"] as const) {
        const button = row.querySelector<HTMLButtonElement>(
          `[data-cloud-action="${action}"]`,
        )!;
        button.disabled = busy || (action === "select" && active);
        button.setAttribute(
          "aria-label",
          `${profile.name}：${button.textContent}`,
        );
      }
    }
    for (const row of existing.values()) row.remove();
    this.container.hidden = this.container.children.length === 0;
  }
}
