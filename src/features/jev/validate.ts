import {
  JevError,
  type Description,
  type JevInput,
  type Json,
  type Question,
} from "./types";
export const LIMITS = {
  characters: 65536,
  questions: 16,
  choices: 32,
  depth: 32,
} as const;
export function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function invalid(message: string): never {
  throw new JevError("INVALID_REQUEST", message);
}
export function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  return (
    required.every((k) => Object.hasOwn(value, k)) &&
    Object.keys(value).every(
      (k) => required.includes(k) || optional.includes(k),
    )
  );
}
// A small JSON reader retains duplicate-key errors that JSON.parse otherwise erases.
// Scalar decoding still uses JSON.parse; no eval or generated validation code.
export function parseJson(text: string): Json {
  if (text.length > LIMITS.characters)
    invalid(`入力は${LIMITS.characters}文字以内です`);
  let i = 0;
  const ws = () => {
    while (/[\t\n\r ]/.test(text[i] ?? "x")) i++;
  };
  function string(): string {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') return JSON.parse(text.slice(start, i));
    }
    return invalid("JSONの文字列が閉じられていません");
  }
  function value(depth: number): Json {
    if (depth > LIMITS.depth) invalid("JSONの入れ子が深すぎます");
    ws();
    if (text[i] === '"') return string();
    if (text[i] === "{") {
      i++;
      ws();
      const out = Object.create(null) as Record<string, Json>;
      if (text[i] === "}") {
        i++;
        return out;
      }
      while (true) {
        ws();
        if (text[i] !== '"') invalid("JSONのキーが必要です");
        const key = string();
        ws();
        if (Object.hasOwn(out, key))
          invalid(`JSONキーが重複しています: ${key}`);
        if (text[i++] !== ":") invalid("JSONに : が必要です");
        out[key] = value(depth + 1);
        ws();
        const c = text[i++];
        if (c === "}") return out;
        if (c !== ",") invalid("JSONに , または } が必要です");
      }
    }
    if (text[i] === "[") {
      i++;
      ws();
      const out: Json[] = [];
      if (text[i] === "]") {
        i++;
        return out;
      }
      while (true) {
        out.push(value(depth + 1));
        ws();
        const c = text[i++];
        if (c === "]") return out;
        if (c !== ",") invalid("JSONに , または ] が必要です");
      }
    }
    const token =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      )?.[0];
    if (!token) invalid("JSON値が必要です");
    i += token.length;
    const result = JSON.parse(token);
    if (typeof result === "number" && !Number.isFinite(result))
      invalid("有限数が必要です");
    return result;
  }
  try {
    const out = value(0);
    ws();
    if (i !== text.length) invalid("JSON末尾に余分な文字があります");
    return out;
  } catch (e) {
    if (e instanceof JevError) throw e;
    return invalid(`不正なJSON: ${String(e)}`);
  }
}
function json(value: unknown, depth = 0): value is Json {
  if (depth > LIMITS.depth) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => json(v, depth + 1));
  return record(value) && Object.values(value).every((v) => json(v, depth + 1));
}
function description(value: unknown): value is Description {
  return (
    (typeof value === "string" || Array.isArray(value) || record(value)) &&
    json(value)
  );
}
export function validateRequest(input: unknown): JevInput {
  if (!record(input) || !exactKeys(input, ["state", "questions"], ["model"]))
    invalid("最上位はstate、questions、任意のmodelのみです");
  if (!description(input.state))
    invalid("stateは文字列・JSONオブジェクト・JSON配列です");
  if (!record(input.questions))
    invalid("questionsは質問IDをキーとするオブジェクトです");
  const entries = Object.entries(input.questions);
  if (entries.length < 1 || entries.length > LIMITS.questions)
    invalid(`質問数は1〜${LIMITS.questions}です`);
  for (const [id, q] of entries) {
    if (!id.trim()) invalid("質問IDを空にできません");
    if (!record(q) || !exactKeys(q, ["type", "instructions"], ["criteria"]))
      invalid(`${id}: 未対応フィールドまたは必須フィールド不足`);
    if (!description(q.instructions))
      invalid(`${id}: instructionsは文字列・オブジェクト・配列です`);
    if (q.type === "choice") {
      if (!record(q.criteria)) invalid(`${id}: choice.criteriaはmapです`);
      const items = Object.entries(q.criteria);
      if (
        items.length < 2 ||
        items.length > LIMITS.choices ||
        items.some(([k, v]) => !k.trim() || (v !== null && !description(v)))
      )
        invalid(
          `${id}: 候補は2〜${LIMITS.choices}件。説明は文字列・構造化値・nullです`,
        );
    } else if (q.type === "score") {
      if (
        !Array.isArray(q.criteria) ||
        q.criteria.length < 2 ||
        q.criteria.length > 10 ||
        !q.criteria.every(description)
      )
        invalid(`${id}: score.criteriaは説明の配列（2〜10段階）です`);
    } else if (q.type === "noul") {
      if (
        Object.hasOwn(q, "criteria") &&
        (!record(q.criteria) ||
          !exactKeys(q.criteria, ["true", "false"]) ||
          !Object.values(q.criteria).every(description))
      )
        invalid(`${id}: noul.criteriaはtrueとfalseの説明です`);
    } else invalid(`${id}: 未対応の質問型 ${String(q.type)}`);
  }
  if (
    Object.hasOwn(input, "model") &&
    (typeof input.model !== "string" || !input.model.trim())
  )
    invalid("modelは登録済みローカルIDです");
  if (JSON.stringify(input).length > LIMITS.characters)
    invalid(`入力は${LIMITS.characters}文字以内です`);
  return input as unknown as JevInput;
}
export interface FormQuestion {
  id: string;
  type: string;
  instructions: string;
  instructionFormat: string;
  criteria: string;
}
export function fromForm(
  state: string,
  stateFormat: string,
  rows: FormQuestion[],
  model?: string,
): JevInput {
  const questions = Object.create(null) as Record<string, Question>;
  for (const row of rows) {
    if (Object.hasOwn(questions, row.id))
      invalid(`質問IDが重複しています: ${row.id}`);
    const q = {
      type: row.type,
      instructions:
        row.instructionFormat === "json"
          ? parseJson(row.instructions)
          : row.instructions,
      ...(row.criteria.trim() ? { criteria: parseJson(row.criteria) } : {}),
    };
    questions[row.id] = q as Question;
  }
  return validateRequest({
    state: stateFormat === "json" ? parseJson(state) : state,
    questions,
    ...(model ? { model } : {}),
  });
}
