import type { ChatCompletionResponse } from "@wllama/wllama";
import type { AnswerToken } from "../../inference/answer-tokens";
import { JevError } from "./types";

// SemIf browser direct-readout approach: read the candidate tokens from the
// public API and normalize in log space. Never parse numbers from model text.
export function tokenReadout(
  response: ChatCompletionResponse,
  slots: readonly AnswerToken[],
) {
  const fail = (detail: string): never => {
    throw new JevError(
      "INVALID_OUTPUT",
      `候補トークンの確率を取得できません: ${detail}`,
    );
  };
  const choice = response.choices?.[0];
  // A one-token readout normally finishes at the token limit, not EOS.
  if (!choice || !["stop", "length"].includes(choice.finish_reason ?? ""))
    fail("生成が正常終了していません");
  const content = choice!.logprobs?.content;
  if (content?.length !== 1) fail("1トークンの確率情報が必要です");
  if (!slots.some((slot) => content![0].token === slot.label))
    fail("モデルが判定用の単一文字を返しませんでした");
  if (response.usage?.completion_tokens !== 1)
    fail("判定前に推論文などが生成されました");
  const entries = content![0].top_logprobs;
  if (!Array.isArray(entries)) fail("候補一覧がありません");
  const logprobs = slots.map(({ label }) => {
    const matches = entries.filter(
      (entry) =>
        entry.token === label &&
        (!entry.bytes ||
          (entry.bytes.length === 1 && entry.bytes[0] === label.charCodeAt(0))),
    );
    if (
      matches.length !== 1 ||
      !Number.isFinite(matches[0].logprob) ||
      matches[0].logprob > 0
    )
      return fail(
        `候補 ${label} の確率が欠損または不正です。このモデルでは現在の判定方式を利用できない可能性があります`,
      );
    return matches[0].logprob;
  });
  const maximum = Math.max(...logprobs);
  const weights = logprobs.map((value) => Math.exp(value - maximum));
  const sum = weights.reduce((a, b) => a + b, 0);
  return { logprobs, probabilities: weights.map((value) => value / sum) };
}
