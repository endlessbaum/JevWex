import type {
  ChatCompletionParams,
  ChatCompletionResponse,
} from "@wllama/wllama";
import {
  asJevError,
  JevError,
  type Answer,
  type JevInput,
  type LocalEvaluation,
  type Snapshot,
} from "./types";
import { validateRequest } from "./validate";
import { messages, options } from "./prompts";
import type { AnswerToken } from "../../inference/answer-tokens";
import { tokenReadout } from "./token-readout";
import { answerFromProbabilities } from "./result-math";
import { imageMetadata, type InputImage } from "./images";
export const MAX_OUTPUT_TOKENS = 1;
export interface ChatRuntime {
  createChatCompletion(
    options: ChatCompletionParams & { stream?: false },
  ): Promise<ChatCompletionResponse>;
}
export async function evaluate(
  runtime: ChatRuntime,
  input: JevInput,
  snapshot: Snapshot,
  tokens: readonly AnswerToken[],
  signal?: AbortSignal,
  images: readonly InputImage[] = [],
): Promise<LocalEvaluation> {
  const request = structuredClone(validateRequest(input));
  if (request.model && request.model !== snapshot.model)
    throw new JevError(
      "INVALID_REQUEST",
      "入力modelとロード済みモデルが一致しません",
    );
  const start = performance.now();
  const answers = Object.create(null) as Record<string, Answer>;
  const normalizations: LocalEvaluation["diagnostics"]["normalizations"] = [];
  const modelOutputs: LocalEvaluation["diagnostics"]["model_outputs"] = [];
  let calls = 0;
  for (const [id, q] of Object.entries(request.questions)) {
    try {
      if (signal?.aborted) throw new JevError("CANCELLED", "中止しました");
      const count = options(q).length;
      if (tokens.length < count)
        throw new JevError(
          "MODEL_UNSUPPORTED",
          `このモデルで使用できる候補は最大${tokens.length}件です（指定${count}件）`,
        );
      const slots = tokens.slice(0, count);
      calls++;
      const result = await runtime.createChatCompletion({
        messages: messages(request.state, q, images, slots),
        stream: false,
        abortSignal: signal,
        grammar: `root ::= ${slots.map(({ label }) => JSON.stringify(label)).join(" | ")}`,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 1,
        top_k: 0,
        top_p: 1,
        min_p: 0,
        typical_p: 1,
        penalty_repeat: 1,
        penalty_freq: 0,
        penalty_present: 0,
        logprobs: true,
        top_logprobs: 64,
        // This runtime returns pre-sampling logprobs: bias does NOT guarantee
        // top-list coverage. Request a wider list and reject missing candidates.
        // Equal bias helps select an allowed token without favoring a candidate.
        // Public typings incorrectly
        // intersect the OAI record with the legacy array form.
        logit_bias: Object.fromEntries(
          slots.map(({ token }) => [String(token), 100]),
        ) as ChatCompletionParams["logit_bias"],
        chat_template_kwargs: { enable_thinking: false },
        cache_prompt: false,
      });
      // Log exactly what the public runtime returned, before validation or normalization.
      console.log("[JevWex raw response]", id, result);
      console.log(
        "[JevWex raw output]",
        id,
        result.choices?.[0]?.message?.content,
      );
      if (signal?.aborted) throw new JevError("CANCELLED", "中止しました");
      const readout = tokenReadout(result, slots);
      modelOutputs.push({
        question: id,
        raw_output: result.choices[0].message.content ?? "",
        output_tokens: result.usage.completion_tokens,
        candidate_tokens: slots.map((slot, i) => ({
          ...slot,
          logprob: readout.logprobs[i],
          probability: readout.probabilities[i],
        })),
      });
      answers[id] = answerFromProbabilities(q, readout.probabilities);
    } catch (error) {
      const e = asJevError(error);
      throw new JevError(e.code, e.message, id);
    }
  }
  return {
    response: { model: snapshot.model, answers },
    diagnostics: {
      ...snapshot,
      runtime:
        globalThis.location?.protocol === "http:" ||
        globalThis.location?.protocol === "https:"
          ? "wllama browser page"
          : "wllama extension page",
      wllama_version: "3.6.1",
      evaluation_ms: performance.now() - start,
      question_count: Object.keys(request.questions).length,
      llm_calls: calls,
      format_validated: true,
      readout_method: "candidate_token_logprobs_v1",
      confidence_method: "typesafe_adapter_e1d4cc9",
      normalizations,
      model_outputs: modelOutputs,
      images: images.map(imageMetadata),
      warnings: [
        "確率は候補トークン間で正規化した値です。未校正であり、正答率ではありません。",
        "confidenceは公式LLMアダプタの算式を参照しています。JEVモデルの精度・確率・完全な独立性は再現しません。",
        "質問を直列に実行し、履歴を共有しません。",
      ],
    },
  };
}
