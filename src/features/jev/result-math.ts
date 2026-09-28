import { JevError, type Answer, type Question } from "./types";
// Formula reference: TypeSafe AI MIT, e1d4cc938204b22fc5a3c3aca7044072fe3f712d.
// See THIRD_PARTY_NOTICES.md. Inputs here have already passed strict validation.
export function confidence(p: number[], type: "choice" | "score"): number {
  const n = p.length,
    peak = Math.max(...p);
  if (type === "choice")
    return Math.min(1, Math.max(0, (peak - 1 / n) / (1 - 1 / n)));
  const mode = p.indexOf(peak),
    center = (n - 1) / 2;
  const distance = p.reduce((s, v, i) => s + v * Math.abs(i - mode), 0);
  const uniform = p.reduce((s, _, i) => s + Math.abs(i - center), 0) / n;
  return Math.min(1, Math.max(0, 1 - distance / uniform));
}
export function answerFromProbabilities(
  q: Question,
  normalized: readonly number[],
): Answer {
  const count =
    q.type === "noul"
      ? 2
      : q.type === "score"
        ? q.criteria.length
        : Object.keys(q.criteria).length;
  if (
    normalized.length !== count ||
    normalized.some((p) => !Number.isFinite(p) || p < 0 || p > 1) ||
    Math.abs(normalized.reduce((sum, p) => sum + p, 0) - 1) > 1e-10
  )
    throw new JevError("INVALID_OUTPUT", "候補確率の分布が不正です");
  if (q.type === "noul") return { type: "noul", noul: normalized[0] };
  const labels =
    q.type === "choice"
      ? Object.keys(q.criteria)
      : q.criteria.map((_, i) => String(i));
  const probabilities = Object.fromEntries(
    labels.map((k, i) => [k, normalized[i]]),
  );
  const c = confidence([...normalized], q.type);
  const answer: Answer =
    q.type === "choice"
      ? {
          type: "choice",
          choice: labels[normalized.indexOf(Math.max(...normalized))],
          probabilities,
          confidence: c,
        }
      : {
          type: "score",
          score: normalized.reduce((s, v, i) => s + i * v, 0),
          probabilities,
          confidence: c,
          legend: Object.fromEntries(
            q.criteria.map((v, i) => [
              String(i),
              typeof v === "string" ? v : JSON.stringify(v),
            ]),
          ),
        };
  return answer;
}
