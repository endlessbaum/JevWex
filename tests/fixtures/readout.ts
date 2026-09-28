import type { ChatCompletionResponse } from "@wllama/wllama";
import { ANSWER_LABELS } from "../../src/inference/answer-tokens";
export const slots = [...ANSWER_LABELS].map((label, i) => ({
  label,
  token: i + 7,
}));
export function gguf(
  vocabulary = ["padding", ...ANSWER_LABELS],
  version = 3,
): Blob {
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    parts.push(b);
  };
  const u64 = (n: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    parts.push(b);
  };
  const str = (s: string) => {
    const b = new TextEncoder().encode(s);
    u64(b.length);
    parts.push(b);
  };
  u32(0x46554747);
  u32(version);
  u64(0);
  u64(2);
  str("general.name");
  u32(8);
  str("synthetic vocabulary");
  str("tokenizer.ggml.tokens");
  u32(9);
  u32(8);
  u64(vocabulary.length);
  vocabulary.forEach(str);
  return new Blob(parts as BlobPart[]);
}
export function response(
  probabilities = [0.8, 0.2],
  text = "A",
  finish = "length",
): ChatCompletionResponse {
  const entries = probabilities.map((p, i) => ({
    token: ANSWER_LABELS[i],
    bytes: [ANSWER_LABELS.charCodeAt(i)],
    logprob: Math.log(p),
  }));
  return {
    choices: [
      {
        message: { content: text },
        finish_reason: finish,
        logprobs: {
          content: [{ ...entries[0], token: text, top_logprobs: entries }],
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
  } as ChatCompletionResponse;
}
