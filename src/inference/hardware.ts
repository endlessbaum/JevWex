import { JevError } from "../features/jev/types";

export interface HardwareSettings {
  device: "cpu" | "webgpu";
  threads: "auto" | number;
  gpuLayers: "all" | number;
  context: number;
  mmprojDevice?: "auto" | "cpu";
}
export interface HardwareCapabilities {
  cores: number;
  multiThread: boolean;
  gpu: boolean;
  gpuName: string;
  gpuReason: string;
}
export interface ResolvedHardware {
  device: "cpu" | "webgpu";
  threads: number;
  gpuLayers: number;
  context: number;
  mmprojDevice?: "auto" | "cpu";
}
export const DEFAULT_HARDWARE: HardwareSettings = {
  mmprojDevice: "auto",
  device: "cpu",
  threads: "auto",
  gpuLayers: "all",
  context: 4096,
};
export const DEFAULT_LOAD: ResolvedHardware = {
  mmprojDevice: "auto",
  device: "cpu",
  threads: 1,
  gpuLayers: 0,
  context: 4096,
};
export const HARDWARE_STORAGE_KEY = "jev.hardware.v1";
export function validateHardware(value: unknown): HardwareSettings {
  const x = value as HardwareSettings | null;
  if (
    !x ||
    (x.mmprojDevice !== undefined &&
      !["auto", "cpu"].includes(x.mmprojDevice)) ||
    !["cpu", "webgpu"].includes(x.device) ||
    !(
      x.threads === "auto" ||
      (Number.isInteger(x.threads) && x.threads >= 1 && x.threads <= 32)
    ) ||
    !(
      x.gpuLayers === "all" ||
      (Number.isInteger(x.gpuLayers) && x.gpuLayers >= 1 && x.gpuLayers <= 128)
    ) ||
    ![1024, 2048, 4096, 8192].includes(x.context)
  )
    throw new JevError(
      "INVALID_REQUEST",
      "ハードウェア設定の値を確認してください。",
    );
  return {
    device: x.device,
    threads: x.threads,
    gpuLayers: x.gpuLayers,
    context: x.context,
    mmprojDevice: x.mmprojDevice ?? "auto",
  };
}
export function resolveHardware(
  settings: HardwareSettings,
  caps: HardwareCapabilities,
): ResolvedHardware {
  const x = validateHardware(settings);
  if (x.device === "webgpu" && !caps.gpu)
    throw new JevError(
      "RUNTIME_UNAVAILABLE",
      "この環境ではGPUを利用できません。CPUを選択してください。",
    );
  if (x.threads !== "auto" && x.threads > 1 && !caps.multiThread)
    throw new JevError(
      "RUNTIME_UNAVAILABLE",
      "複数CPUスレッドを利用できません。1スレッドまたは自動を選んでください。",
    );
  const max = Math.max(1, Math.min(32, caps.cores));
  if (x.threads !== "auto" && x.threads > max)
    throw new JevError(
      "INVALID_REQUEST",
      `CPUスレッド数はこの環境では${max}以下にしてください。`,
    );
  const threads =
    x.threads === "auto"
      ? caps.multiThread
        ? Math.max(1, Math.min(8, Math.floor(max / 2)))
        : 1
      : x.threads;
  return {
    device: x.device,
    threads,
    gpuLayers:
      x.device === "cpu" ? 0 : x.gpuLayers === "all" ? 99999 : x.gpuLayers,
    context: x.context,
    mmprojDevice: x.mmprojDevice,
  };
}
export function sameHardware(a: ResolvedHardware, b: ResolvedHardware) {
  return (
    a.device === b.device &&
    a.threads === b.threads &&
    a.gpuLayers === b.gpuLayers &&
    a.context === b.context &&
    projectorOffload(a) === projectorOffload(b)
  );
}
export function projectorOffload(settings: ResolvedHardware) {
  return settings.device === "webgpu" && settings.mmprojDevice !== "cpu";
}
export function readHardware(
  storage: Pick<Storage, "getItem">,
): HardwareSettings {
  try {
    const raw = storage.getItem(HARDWARE_STORAGE_KEY);
    return raw ? validateHardware(JSON.parse(raw)) : { ...DEFAULT_HARDWARE };
  } catch {
    return { ...DEFAULT_HARDWARE };
  }
}
// WebGPU types are kept local; no extra runtime library or private wllama API.
interface BrowserGPU {
  requestAdapter(): Promise<{
    info?: { description?: string; vendor?: string; architecture?: string };
    isFallbackAdapter?: boolean;
  } | null>;
}
export async function detectHardware(): Promise<HardwareCapabilities> {
  let multiThread = false;
  try {
    multiThread =
      crossOriginIsolated &&
      typeof SharedArrayBuffer !== "undefined" &&
      new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
        .buffer instanceof SharedArrayBuffer;
  } catch {
    /* CPU single-thread remains usable. */
  }
  const caps: HardwareCapabilities = {
    cores: Math.max(1, navigator.hardwareConcurrency || 1),
    multiThread,
    gpu: false,
    gpuName: "未検出",
    gpuReason: "このブラウザではWebGPUを利用できません。",
  };
  const gpu = (navigator as Navigator & { gpu?: BrowserGPU }).gpu;
  if (!gpu) return caps;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 5000);
      }),
    ]);
    if (adapter) {
      caps.gpu = true;
      caps.gpuName =
        adapter.info?.description ||
        [adapter.info?.vendor, adapter.info?.architecture]
          .filter(Boolean)
          .join(" ") ||
        "WebGPU対応デバイス";
      caps.gpuReason = adapter.isFallbackAdapter
        ? "ソフトウェアGPUです。高速化しない場合があります。"
        : "利用候補を検出しました。モデルを読み込んで動作を確認します。";
    } else
      caps.gpuReason =
        "GPUを取得できませんでした。Chromeのグラフィックアクセラレーション設定などを確認してください。";
  } catch {
    caps.gpuReason = "GPUの確認に失敗しました。CPUは利用できます。";
  } finally {
    clearTimeout(timer);
  }
  return caps;
}
