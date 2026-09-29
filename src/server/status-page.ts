const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export class ServerPage {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private token = "";
  constructor() {
    const nav = document.createElement("a");
    nav.id = "nav-server";
    nav.href = "#server";
    nav.textContent = "⇄ HTTP API";
    document.querySelector("nav")!.append(nav);
    const view = document.createElement("div");
    view.id = "server-page";
    view.hidden = true;
    view.innerHTML = `<header><div><p class="eyebrow">Webサーバー版</p><h1 tabindex="-1">HTTP API</h1><p class="lead">この画面を閉じても、サーバーの起動中はAPIを利用できます。</p></div></header>
      <section><h2>API用モデルの状態</h2><p>APIはサーバー専用のモデルで判定します。「モデル管理」と「ハードウェア設定」は、このブラウザの画面で判定するときの設定です。</p>
      <label>APIトークン<input id="server-token" type="password" autocomplete="off" spellcheck="false" placeholder="サーバー起動時のトークン" /></label><button id="server-refresh" class="secondary">状態を確認</button>
      <p id="server-status" role="status" aria-live="polite">状態を確認するにはAPIトークンを入力してください。</p><p id="server-model"></p><p id="server-hardware"></p></section>
      <section><h2>モデルを変更する</h2><p>プロジェクトの <code>server.config.example.json</code> を <code>server.config.json</code> としてコピーし、モデル・画像用ファイル・ハードウェア設定を変更してサーバーを再起動してください。</p><p>初期モデルはQwen3-0.6BのQ4_K_M版です。APIから任意のモデルを勝手にダウンロード・切り替えることはありません。</p></section>
      <section><h2>プログラムから使う</h2><p>判定：<code id="server-endpoint"></code></p><p>状態確認：<code>/api/v1/status</code></p><p>使い方は <code>docs/server.md</code>、Python・Node.jsの例は <code>examples/server/</code> にあります。</p></section>`;
    document.querySelector("main")!.prepend(view);
    $("server-endpoint").textContent = `${location.origin}/api/v1/evaluate`;
    document.querySelector(".brand-small")!.textContent = "Web × WebAssembly";
    document.querySelector("footer")!.textContent =
      "画面の入力と結果は自動保存しません。タブを閉じると画面側のモデルは終了します。HTTP APIはサーバーの起動中、引き続き利用できます。";
    const supplied = new URLSearchParams(location.hash.slice(1)).get("token");
    if (supplied !== null) {
      this.token = supplied;
      history.replaceState(null, "", location.pathname + "#server");
    } else {
      try {
        this.token = sessionStorage.getItem("jevwex.web.api-token") ?? "";
      } catch {
        /* optional */
      }
    }
    $<HTMLInputElement>("server-token").value = this.token;
    $("server-refresh").onclick = () => {
      this.token = $<HTMLInputElement>("server-token").value.trim();
      clearTimeout(this.timer);
      void this.refresh();
    };
    if (this.token) void this.refresh();
  }
  private async refresh() {
    try {
      const response = await fetch("/api/v1/status", {
        headers: { Authorization: `Bearer ${this.token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      const status = await response.json();
      if (!response.ok)
        throw new Error(status.error?.message ?? "状態を取得できませんでした");
      if (this.stopped) return;
      try {
        sessionStorage.setItem("jevwex.web.api-token", this.token);
      } catch {
        /* optional */
      }
      $("server-status").textContent =
        `${status.phase === "ready" ? "準備完了" : status.phase === "running" ? "判定中" : status.phase === "error" ? "エラー" : "準備中"}：${status.detail} / 受付中 ${status.pending}件`;
      $("server-model").textContent = status.loaded
        ? `API用モデル：${status.loaded.model}`
        : "モデルを準備しています。";
      $("server-hardware").textContent = status.loaded
        ? `CPU ${status.loaded.threads}スレッド / 文章量 ${status.loaded.context} / GPU ${status.loaded.hardware?.gpu_layers_offloaded ?? "未確認"}層`
        : "";
      this.timer = setTimeout(() => void this.refresh(), 3000);
    } catch (error) {
      if (!this.stopped)
        $("server-status").textContent =
          error instanceof Error ? error.message : String(error);
    }
  }
  disconnect() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
