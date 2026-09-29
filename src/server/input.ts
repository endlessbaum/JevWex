import { JevError } from "../features/jev/types";
import { record, validateRequest } from "../features/jev/validate";
import {
  readImage,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  type InputImage,
} from "../features/jev/images";
export async function decodeApiInput(value: unknown) {
  const invalid = (message: string): never => {
    throw new JevError("INVALID_REQUEST", message);
  };
  if (!record(value)) return invalid("入力はオブジェクトで指定してください");
  const { images = [], ...input } = value;
  const request = validateRequest(input);
  if (!Array.isArray(images) || images.length > MAX_IMAGES)
    return invalid("画像は4枚までです");
  const decoded: InputImage[] = [];
  for (const image of images) {
    if (
      !record(image) ||
      typeof image.name !== "string" ||
      !image.name ||
      image.name.length > 256 ||
      !["image/png", "image/jpeg"].includes(String(image.mime_type)) ||
      typeof image.data_base64 !== "string" ||
      !image.data_base64.length ||
      image.data_base64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) ||
      image.data_base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data_base64)
    )
      return invalid(
        "画像はname・mime_type・data_base64で指定してください（PNG/JPEG・1枚10 MiB以下）",
      );
    const bytes = Uint8Array.from(atob(image.data_base64), (char) =>
      char.charCodeAt(0),
    );
    decoded.push(
      await readImage(
        new File([bytes], image.name, { type: String(image.mime_type) }),
      ),
    );
  }
  return { request, images: decoded };
}
