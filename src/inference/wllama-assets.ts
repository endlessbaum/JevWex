import { Wllama } from "@wllama/wllama";
export function createRuntime(onLog?: (text: string) => void): Wllama {
  const log = (...args: unknown[]) => {
    for (const arg of args) if (typeof arg === "string") onLog?.(arg);
  };
  const runtime = new Wllama(
    { default: new URL("runtime/wllama.wasm", document.baseURI).href },
    {
      suppressNativeLog: false,
      logger: { debug: log, log, warn: log, error: log },
    },
  );
  runtime.setCompat(null); // No compatibility CDN requests, including failure paths.
  return runtime;
}
