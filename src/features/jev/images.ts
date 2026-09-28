import { JevError } from "./types";

export interface InputImage {
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export function validateImageFiles(
  files: readonly Pick<File, "name" | "type" | "size">[],
  existing = 0,
) {
  if (existing + files.length > MAX_IMAGES)
    throw new JevError("INVALID_REQUEST", "画像は4枚まで追加できます。");
  for (const file of files) {
    if (!["image/png", "image/jpeg"].includes(file.type))
      throw new JevError(
        "INVALID_REQUEST",
        "PNG・JPEGの画像を選択してください。",
      );
    if (!file.size || file.size > MAX_IMAGE_BYTES)
      throw new JevError(
        "INVALID_REQUEST",
        "画像は1枚10 MiB以下の空でないファイルを選択してください。",
      );
  }
}
export async function readImage(file: File): Promise<InputImage> {
  validateImageFiles([file]);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new JevError(
      "INVALID_REQUEST",
      `画像「${file.name}」を読み取れませんでした。`,
    );
  }
  const { width, height } = bitmap;
  bitmap.close();
  if (width * height > 20_000_000)
    throw new JevError(
      "INVALID_REQUEST",
      "画像は2,000万画素以下に縮小してください。",
    );
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    width,
    height,
    data: await file.arrayBuffer(),
  };
}
export function imageMetadata({ data: _data, ...metadata }: InputImage) {
  return metadata;
}
