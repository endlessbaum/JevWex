import { JevError } from "../features/jev/types";

// Single ASCII tokens avoid model-specific token IDs. These are read from the
// selected GGUF, never inferred from a model name or a private runtime binding.
export const ANSWER_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
export interface AnswerToken {
  label: string;
  token: number;
}
class NeedMore extends Error {}
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function parseAnswerTokens(buffer: ArrayBuffer): AnswerToken[] | null {
  const view = new DataView(buffer);
  let offset = 0;
  function take(size: number): number {
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + size > MAX_METADATA_BYTES
    )
      throw new Error("GGUFメタデータが上限を超えています");
    if (offset + size > view.byteLength) throw new NeedMore();
    const start = offset;
    offset += size;
    return start;
  }
  const u32 = () => view.getUint32(take(4), true);
  const u64 = () => {
    const value = view.getBigUint64(take(8), true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("不正なGGUF長です");
    return Number(value);
  };
  function string(read = true): string {
    const length = u64(),
      start = take(length);
    return read ? decoder.decode(new Uint8Array(buffer, start, length)) : "";
  }
  function skip(type: number, depth = 0): void {
    if (depth > 4) throw new Error("不正なGGUF配列です");
    const sizes: Record<number, number> = {
      0: 1,
      1: 1,
      2: 2,
      3: 2,
      4: 4,
      5: 4,
      6: 4,
      7: 1,
      10: 8,
      11: 8,
      12: 8,
    };
    if (sizes[type]) {
      take(sizes[type]);
      return;
    }
    if (type === 8) {
      string(false);
      return;
    }
    if (type !== 9) throw new Error("未対応のGGUF値です");
    const element = u32(),
      count = u64();
    if (count > 2_000_000) throw new Error("GGUF配列が大きすぎます");
    if (sizes[element]) take(count * sizes[element]);
    else for (let i = 0; i < count; i++) skip(element, depth + 1);
  }
  if (u32() !== 0x46554747) throw new Error("GGUFではありません");
  if (![2, 3].includes(u32())) throw new Error("GGUF v2/v3が必要です");
  u64(); // tensor count; tensor data is never read
  const count = u64();
  if (count > 100_000) throw new Error("GGUFキーが多すぎます");
  for (let i = 0; i < count; i++) {
    const key = string(),
      type = u32();
    if (key !== "tokenizer.ggml.tokens") {
      skip(type);
      continue;
    }
    if (type !== 9 || u32() !== 8)
      throw new Error("GGUF語彙は文字列配列である必要があります");
    const length = u64();
    if (length > 2_000_000) throw new Error("GGUF語彙が大きすぎます");
    const ids = new Map<string, number[]>();
    for (let token = 0; token < length; token++) {
      const text = string();
      if (text.length === 1 && ANSWER_LABELS.includes(text))
        ids.set(text, [...(ids.get(text) ?? []), token]);
    }
    return [...ANSWER_LABELS].flatMap((label) => {
      const tokens = ids.get(label);
      return tokens?.length === 1 ? [{ label, token: tokens[0] }] : [];
    });
  }
  return null; // a projector or a shard without vocabulary
}

export async function readAnswerTokens(
  files: readonly Blob[],
): Promise<AnswerToken[]> {
  for (const file of files) {
    let size = Math.min(file.size, 1024 * 1024);
    for (;;) {
      try {
        const tokens = parseAnswerTokens(
          await file.slice(0, size).arrayBuffer(),
        );
        if (tokens) {
          if (tokens.length < 2)
            throw new Error("単一文字の判定用トークンが不足しています");
          return tokens;
        }
        break;
      } catch (error) {
        if (
          error instanceof NeedMore &&
          size < Math.min(file.size, MAX_METADATA_BYTES)
        ) {
          size = Math.min(size * 2, file.size, MAX_METADATA_BYTES);
          continue;
        }
        throw new JevError(
          "MODEL_UNSUPPORTED",
          `モデルの判定用語彙を読み取れません: ${error instanceof NeedMore ? "GGUFメタデータが不完全、または64 MiBを超えています" : String(error)}`,
        );
      }
    }
  }
  throw new JevError("MODEL_UNSUPPORTED", "GGUFに判定用語彙がありません");
}
