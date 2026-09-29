import type { JevInput, LocalEvaluation } from "../features/jev/types";
import type { Presentation } from "../pages/jev/criteria-editor";
import type { PageImage } from "./page-images";

// Only extension-origin documents can join this channel. Page content never
// gets an inference API, and the model stays in its existing management tab.
export const JUDGE_CHANNEL = "jev-web-page-judge-v1";
export interface ManagerStatus {
  id: string;
  tabId?: number;
  ready: boolean;
  model: string;
  phase: string;
  supportsImages?: boolean;
}
export interface WebRequest {
  requestId: string;
  clientId: string;
  managerId: string;
  ruleId: string;
  url: string;
  text: string;
  images?: PageImage[];
}
export interface WebResult {
  evaluation: LocalEvaluation;
  input: JevInput;
  presentation: Presentation;
}
export type JudgeMessage =
  | { type: "hello" }
  | { type: "status"; status: ManagerStatus }
  | { type: "closed"; managerId: string }
  | { type: "evaluate"; request: WebRequest }
  | { type: "cancel"; requestId: string; clientId: string; managerId: string }
  | {
      type: "manage";
      managerId: string;
      destination: "models" | "sites";
      url?: string;
    }
  | {
      type: "result";
      requestId: string;
      clientId: string;
      managerId: string;
      result?: WebResult;
      error?: string;
    };

export class ManagerBridge {
  readonly id = crypto.randomUUID();
  private channel = new BroadcastChannel(JUDGE_CHANNEL);
  private tabId?: number;
  private running?: WebRequest;
  private closed = false;
  private controller?: AbortController;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private options: {
      status: () => Omit<ManagerStatus, "id" | "tabId">;
      evaluate: (
        request: WebRequest,
        signal: AbortSignal,
      ) => Promise<WebResult>;
      cancel: () => Promise<void>;
      manage: (destination: "models" | "sites", url?: string) => void;
    },
  ) {
    this.channel.onmessage = ({ data }: MessageEvent<JudgeMessage>) => {
      if (data.type === "hello") this.publish();
      if (data.type === "evaluate" && data.request.managerId === this.id)
        void this.evaluate(data.request);
      if (
        data.type === "cancel" &&
        data.managerId === this.id &&
        this.running?.requestId === data.requestId &&
        this.running.clientId === data.clientId
      ) {
        this.controller?.abort();
        void this.options.cancel().catch(() => {});
      }
      if (data.type === "manage" && data.managerId === this.id)
        this.options.manage(data.destination, data.url);
    };
    void chrome.tabs.getCurrent().then((tab) => {
      this.tabId = tab?.id;
      this.publish();
    });
    this.timer = setInterval(() => this.publish(), 5000);
    this.publish();
  }
  publish() {
    if (this.closed) return;
    this.channel.postMessage({
      type: "status",
      status: {
        ...this.options.status(),
        id: this.id,
        tabId: this.tabId,
        ready: !this.running && this.options.status().ready,
      },
    } satisfies JudgeMessage);
  }
  private async evaluate(request: WebRequest) {
    const reply = (result?: WebResult, error?: string) => {
      if (!this.closed)
        this.channel.postMessage({
          type: "result",
          requestId: request.requestId,
          clientId: request.clientId,
          managerId: this.id,
          result,
          error,
        } satisfies JudgeMessage);
    };
    if (this.running || !this.options.status().ready) {
      reply(
        undefined,
        "管理画面のモデルが未準備、または別の判定を実行中です。",
      );
      return;
    }
    this.running = request;
    this.controller = new AbortController();
    this.publish();
    try {
      reply(await this.options.evaluate(request, this.controller.signal));
    } catch (e) {
      reply(undefined, (e as Error).message);
    } finally {
      this.running = undefined;
      this.controller = undefined;
      this.publish();
    }
  }
  close() {
    this.closed = true;
    this.controller?.abort();
    if (this.running) void this.options.cancel().catch(() => {});
    clearInterval(this.timer);
    this.channel.postMessage({
      type: "closed",
      managerId: this.id,
    } satisfies JudgeMessage);
    this.channel.close();
  }
}
