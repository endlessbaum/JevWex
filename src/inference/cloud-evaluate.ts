import {
  JevError,
  type Answer,
  type JevInput,
  type LocalEvaluation,
  type Question,
  type Snapshot,
} from "../features/jev/types";
import { exactKeys, record, validateRequest } from "../features/jev/validate";
import { validateCloudSettings, type CloudConnection } from "./cloud-settings";

const invalid = (): never => {
  throw new JevError(
    "INVALID_OUTPUT",
    "APIの回答形式・質問ID・候補確率が不正です。",
  );
};
const probability = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
function distribution(value: unknown, count: number): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    !value.every(probability) ||
    Math.abs(value.reduce((s, p) => s + p, 0) - 1) > 0.0001
  )
    return invalid();
  return value;
}
function labels(q: Question): string[] {
  return q.type === "choice"
    ? Object.keys(q.criteria)
    : q.type === "score"
      ? q.criteria.map((_, i) => String(i))
      : ["true", "false"];
}
export function validateJevResponse(
  value: unknown,
  request: JevInput,
): LocalEvaluation["response"] {
  // JevWex's HTTP endpoint wraps the same contract in { response, diagnostics }.
  if (
    record(value) &&
    !Object.hasOwn(value, "answers") &&
    record(value.response)
  )
    value = value.response;
  if (
    !record(value) ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    !record(value.answers) ||
    !exactKeys(value.answers, Object.keys(request.questions))
  )
    return invalid();
  const answers: Record<string, Answer> = Object.create(null);
  for (const [id, q] of Object.entries(request.questions)) {
    const a = value.answers[id];
    if (!record(a) || a.type !== q.type) return invalid();
    if (q.type === "noul") {
      if (!probability(a.noul)) return invalid();
      answers[id] = { type: "noul", noul: a.noul };
      continue;
    }
    const keys = labels(q),
      p = a.probabilities;
    if (!record(p) || !exactKeys(p, keys) || !probability(a.confidence))
      return invalid();
    const values = distribution(
      keys.map((k) => p[k]),
      keys.length,
    );
    const probabilities = Object.fromEntries(
      keys.map((k, i) => [k, values[i]]),
    );
    if (q.type === "choice") {
      if (
        typeof a.choice !== "string" ||
        !keys.includes(a.choice) ||
        p[a.choice] !== Math.max(...values)
      )
        return invalid();
      answers[id] = {
        type: "choice",
        choice: a.choice,
        probabilities,
        confidence: a.confidence,
      };
    } else {
      if (
        typeof a.score !== "number" ||
        !Number.isFinite(a.score) ||
        a.score < 0 ||
        a.score > keys.length - 1 ||
        Math.abs(a.score - values.reduce((s, p, i) => s + p * i, 0)) > 0.01 ||
        !record(a.legend) ||
        !exactKeys(a.legend, keys) ||
        !Object.values(a.legend).every((v) => typeof v === "string")
      )
        return invalid();
      answers[id] = {
        type: "score",
        score: a.score,
        probabilities,
        confidence: a.confidence,
        legend: Object.fromEntries(
          keys.map((k) => [k, (a.legend as Record<string, string>)[k]]),
        ),
      };
    }
  }
  return { model: value.model, answers };
}
export async function evaluateCloud(
  connection: CloudConnection,
  input: JevInput,
  snapshot: Snapshot,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<LocalEvaluation> {
  const config = validateCloudSettings(connection),
    request = structuredClone(validateRequest(input));
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutSeconds * 1000);
  const start = performance.now();
  try {
    controller.signal.throwIfAborted();
    const response = await fetcher(config.endpoint, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(connection.apiKey
          ? { Authorization: `Bearer ${connection.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        state: request.state,
        questions: request.questions,
        model: config.model,
      }),
    });
    if (!response.ok)
      throw new JevError(
        "RUNTIME_UNAVAILABLE",
        `クラウドAPIがHTTP ${response.status}を返しました。認証・モデルID・利用制限を確認してください。`,
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return invalid();
    }
    controller.signal.throwIfAborted();
    const result = validateJevResponse(body, request);
    return {
      response: result,
      diagnostics: {
        ...snapshot,
        model: result.model,
        runtime: "cloud API",
        provider: config.provider,
        evaluation_ms: performance.now() - start,
        question_count: Object.keys(request.questions).length,
        llm_calls: 1,
        format_validated: true,
        confidence_method: "provider",
        readout_method: "jev_api",
        warnings: [
          "確率とconfidenceはクラウドAPIの返却値です。正答率を保証しません。",
        ],
        normalizations: [],
        model_outputs: [],
      },
    };
  } catch (e) {
    if (signal?.aborted) throw new JevError("CANCELLED", "中止しました");
    if (timedOut)
      throw new JevError(
        "TIMEOUT",
        `クラウドAPIの応答が${config.timeoutSeconds}秒を超えました。`,
      );
    if (e instanceof JevError) throw e;
    // Never put a provider's arbitrary body, endpoint or credentials in logs/results.
    throw new JevError(
      "RUNTIME_UNAVAILABLE",
      "クラウドAPIに接続できません。送信先・ネットワーク・アクセス許可・CORSを確認してください。",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
