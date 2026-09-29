import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  readImage,
  type InputImage,
} from "../features/jev/images";

export interface PageImage {
  url: string;
  label: string;
}

export function imageOrigin(value: string): string | undefined {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
  return `${url.protocol}//${url.hostname}/*`;
}

export function imageOrigins(images: readonly PageImage[]): string[] {
  return [
    ...new Set(
      images.flatMap(({ url }) => {
        try {
          const origin = imageOrigin(url);
          return origin ? [origin] : [];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

function embeddedImage(url: string): Response {
  const comma = url.indexOf(","),
    header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const bytes = /;base64$/i.test(header)
    ? Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new Response(bytes, {
    headers: { "content-type": header.split(";")[0] },
  });
}

// Runs in the model's extension document. Only selected image URLs are fetched;
// no page endpoint exposes the downloaded bytes or an arbitrary fetch API.
export async function loadPageImages(
  images: readonly PageImage[],
  signal: AbortSignal,
): Promise<InputImage[]> {
  if (images.length > MAX_IMAGES)
    throw new Error(
      "1件の対象に画像が4枚を超えています。不要な画像を除外するか、子要素を1件ずつ判定してください。",
    );
  const output: InputImage[] = [];
  for (const [index, image] of images.entries()) {
    signal.throwIfAborted();
    const origin = imageOrigin(image.url);
    if (
      !origin &&
      !/^data:image\/(png|jpeg|webp|avif|gif)[;,]/i.test(image.url)
    )
      throw new Error(
        "この画像のURLは取得できません。HTTP(S)または埋め込み画像を選択してください（blob・SVGは対象外）。",
      );
    if (origin && !(await chrome.permissions.contains({ origins: [origin] })))
      throw new Error(
        `画像の取得元 ${origin} が未許可です。条件の作成・編集画面で「画像の取得元を許可」を押してください。`,
      );
    if (!origin && image.url.length > MAX_IMAGE_BYTES * 1.4)
      throw new Error("画像は1枚10 MiB以下にしてください。");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 30000);
    try {
      const response = origin
        ? await fetch(image.url, {
            signal: controller.signal,
            credentials: "omit",
            referrerPolicy: "no-referrer",
          })
        : embeddedImage(image.url);
      if (!response.ok)
        throw new Error(
          `画像の取得に失敗しました（HTTP ${response.status}）。`,
        );
      const mime =
        response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? "";
      if (
        ![
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/avif",
          "image/gif",
        ].includes(mime)
      )
        throw new Error(
          "PNG・JPEG・WebP・AVIF・GIF形式の画像を選択してください。",
        );
      if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES)
        throw new Error("画像は1枚10 MiB以下にしてください。");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("画像データがありません。");
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES)
            throw new Error("画像は1枚10 MiB以下にしてください。");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bitmap = await createImageBitmap(new Blob(chunks, { type: mime }));
      try {
        if (
          !bitmap.width ||
          !bitmap.height ||
          bitmap.width * bitmap.height > 20_000_000
        )
          throw new Error("画像は2,000万画素以下にしてください。");
        // Normalize browser formats for the runtime's PNG/JPEG image decoder.
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        output.push(
          await readImage(
            new File([blob], `page-image-${index + 1}.png`, {
              type: "image/png",
            }),
          ),
        );
      } finally {
        bitmap.close();
      }
      signal.throwIfAborted();
      if (controller.signal.aborted)
        throw new Error("画像の取得が時間内に完了しませんでした。");
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(
        `画像「${image.label || index + 1}」を取得できませんでした：${controller.signal.aborted ? "取得がタイムアウトしました。" : (error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return output;
}
