export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Description = string | Json[] | { [key: string]: Json };
export type Question =
  | {
      type: "choice";
      instructions: Description;
      criteria: Record<string, Description | null>;
    }
  | { type: "score"; instructions: Description; criteria: Description[] }
  | {
      type: "noul";
      instructions: Description;
      criteria?: { true: Description; false: Description };
    };
export interface JevInput {
  state: Description;
  questions: Record<string, Question>;
  model?: string;
}
export type Answer =
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      probabilities: Record<string, number>;
      confidence: number;
      legend: Record<string, string>;
    }
  | { type: "noul"; noul: number };
export interface Snapshot {
  model: string;
  generation: number;
  load_ms: number;
  threads: number;
  context: number;
  supports_images?: boolean;
  hardware?: {
    requested: import("../../inference/hardware").ResolvedHardware;
    gpu_layers_offloaded: number | null;
  };
}
export interface LocalEvaluation {
  response: { model: string; answers: Record<string, Answer> };
  diagnostics: Snapshot & {
    runtime: "wllama extension page";
    wllama_version: "3.6.1";
    evaluation_ms: number;
    question_count: number;
    llm_calls: number;
    format_validated: true;
    confidence_method: "typesafe_adapter_e1d4cc9";
    readout_method?: "candidate_token_logprobs_v1";
    warnings: string[];
    model_outputs: {
      question: string;
      raw_output: string;
      candidate_tokens?: {
        label: string;
        token: number;
        logprob: number;
        probability: number;
      }[];
      output_tokens?: number;
    }[];
    images?: Omit<import("./images").InputImage, "data">[];
    normalizations: {
      question: string;
      original_sum: number;
      action: string;
    }[];
  };
}
export type ErrorCode =
  | "MODEL_NOT_LOADED"
  | "MODEL_UNSUPPORTED"
  | "INVALID_REQUEST"
  | "RUNTIME_UNAVAILABLE"
  | "LOAD_FAILED"
  | "DOWNLOAD_FAILED"
  | "CONTEXT_LIMIT"
  | "OUTPUT_LIMIT"
  | "INVALID_OUTPUT"
  | "CANCELLED"
  | "BUSY";
export class JevError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public question?: string,
  ) {
    super(message);
    this.name = "JevError";
  }
}
export function asJevError(error: unknown): JevError {
  if (error instanceof JevError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "AbortError")
    return new JevError("CANCELLED", "中止しました");
  if (/chat.*template|template.*(support|fail|error)|jinja/i.test(message))
    return new JevError("MODEL_UNSUPPORTED", message);
  if (/context|kv.cache|too (long|large)|exceed.*token/i.test(message))
    return new JevError("CONTEXT_LIMIT", message);
  return new JevError("RUNTIME_UNAVAILABLE", message);
}
