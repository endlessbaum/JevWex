import {
  asJevError,
  JevError,
  type JevInput,
  type LocalEvaluation,
  type Question,
  type Snapshot,
} from "./types";
import { validateRequest } from "./validate";

export const MAX_BATCH_ROWS = 10000;
export const MAX_BATCH_BYTES = 20 * 1024 * 1024;
export interface BatchItem {
  number: number;
  name: string;
  text: string;
  image?: { name: string; type: string; size: number };
}
export interface BatchRow extends BatchItem {
  status: "pending" | "running" | "success" | "error" | "cancelled";
  result?: LocalEvaluation;
  error?: { code: string; message: string; question?: string };
}
export interface BatchReport {
  startedAt: string;
  finishedAt?: string;
  model: Snapshot;
  questions: JevInput["questions"];
  rows: BatchRow[];
}
function invalid(message: string): never {
  throw new JevError("INVALID_REQUEST", message);
}

function checkSize(source: string) {
  if (
    source.length > MAX_BATCH_BYTES ||
    new TextEncoder().encode(source).byteLength > MAX_BATCH_BYTES
  )
    invalid("取り込めるデータは20 MiBまでです。");
}

// RFC 4180-style quoted cells, including embedded newlines. Excel paste uses tabs.
export function parseTable(source: string, delimiter?: string): string[][] {
  checkSize(source);
  const text = source.replace(/^\uFEFF/, "");
  if (!delimiter) {
    let quoted = false;
    delimiter = ",";
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') quoted = !quoted;
      if (!quoted && /[\r\n]/.test(text[i])) break;
      if (!quoted && text[i] === "\t") {
        delimiter = "\t";
        break;
      }
    }
  }
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    closed = false;
    if (row.length > 256) invalid("表の列は256列までです。");
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
    if (rows.length > MAX_BATCH_ROWS + 1)
      invalid("一括判定は10,000件までです。");
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (c === delimiter) endCell();
    else if (c === "\r" || c === "\n") {
      endRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else if (closed) {
      if (c !== " " && c !== "\t")
        invalid(
          "閉じた引用符の後に余分な文字があります。表の形式を確認してください。",
        );
    } else if (c === '"') {
      if (cell) invalid("表の引用符の位置が不正です。");
      quoted = true;
    } else cell += c;
  }
  if (quoted) invalid("表の引用符が閉じられていません。");
  if (cell || closed || row.length) endRow();
  if (rows.some((row) => row.length !== rows[0].length))
    invalid(
      "表の列数が行によって異なります。改行やカンマを含むセルは引用符で囲んでください。",
    );
  return rows;
}
export function lineItems(text: string): BatchItem[] {
  checkSize(text);
  const rows = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim());
  if (rows.length > MAX_BATCH_ROWS) invalid("一括判定は10,000件までです。");
  return rows.map((text, i) => ({
    number: i + 1,
    name: `データ${i + 1}`,
    text,
  }));
}
export function tableItems(
  rows: string[][],
  header: boolean,
  contentColumn: number,
  nameColumn = -1,
): BatchItem[] {
  if (!rows.length) return [];
  if (
    contentColumn < -1 ||
    contentColumn >= rows[0].length ||
    nameColumn < -1 ||
    nameColumn >= rows[0].length
  )
    invalid("判定する列とデータ名の列を選び直してください。");
  const data = rows.slice(header ? 1 : 0);
  if (data.length > MAX_BATCH_ROWS) invalid("一括判定は10,000件までです。");
  return data.map((cells, i) => ({
    number: i + 1,
    name: (nameColumn >= 0 ? cells[nameColumn].trim() : "") || `データ${i + 1}`,
    text:
      contentColumn >= 0
        ? cells[contentColumn]
        : cells
            .map(
              (value, column) =>
                `${header ? rows[0][column] : `列${column + 1}`}：${value}`,
            )
            .join("\n"),
  }));
}
export function newBatch(
  items: BatchItem[],
  questions: JevInput["questions"],
  model: Snapshot,
): BatchReport {
  if (!items.length || items.length > MAX_BATCH_ROWS)
    invalid("判定するデータを1〜10,000件取り込んでください。");
  validateRequest({ state: "判定対象", questions });
  return structuredClone({
    startedAt: new Date().toISOString(),
    model,
    questions,
    rows: items.map((item) => ({ ...item, status: "pending" as const })),
  });
}
export async function runBatch(
  report: BatchReport,
  evaluate: (
    input: JevInput,
    signal: AbortSignal,
    row: BatchRow,
  ) => Promise<LocalEvaluation>,
  signal: AbortSignal,
  update: () => void,
): Promise<void> {
  delete report.finishedAt;
  for (const row of report.rows) {
    if (signal.aborted) break;
    if (row.status === "success") continue;
    row.status = "running";
    delete row.error;
    delete row.result;
    update();
    try {
      if (!row.text.trim() && !row.image)
        invalid("判定する内容が空です。取り込んだ列を確認してください。");
      const input = validateRequest({
        state: row.text || "添付画像を判定してください。",
        questions: report.questions,
        model: report.model.model,
      });
      row.result = await evaluate(input, signal, row);
      if (signal.aborted) throw new JevError("CANCELLED", "中止しました");
      row.status = "success";
    } catch (error) {
      delete row.result;
      const e = asJevError(error);
      row.status =
        signal.aborted || e.code === "CANCELLED" ? "cancelled" : "error";
      row.error = { code: e.code, message: e.message, question: e.question };
      update();
      if (
        row.status === "cancelled" ||
        [
          "RUNTIME_UNAVAILABLE",
          "MODEL_NOT_LOADED",
          "MODEL_UNSUPPORTED",
          "LOAD_FAILED",
          "BUSY",
        ].includes(e.code)
      )
        break;
      continue;
    }
    update();
  }
  report.finishedAt = new Date().toISOString();
  update();
}
export interface CriterionSummary {
  type: Question["type"];
  count: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  counts: Record<string, number>;
  meanWeights: Record<string, number>;
  atLeastHalf: number;
}
export function summarizeBatch(report: BatchReport) {
  const totals = {
    total: report.rows.length,
    success: 0,
    error: 0,
    cancelled: 0,
    pending: 0,
    running: 0,
  };
  const criteria: Record<string, CriterionSummary> = Object.create(null);
  for (const [id, q] of Object.entries(report.questions)) {
    const keys =
      q.type === "choice"
        ? Object.keys(q.criteria)
        : q.type === "score"
          ? q.criteria.map((_, i) => String(i))
          : [];
    criteria[id] = {
      type: q.type,
      count: 0,
      mean: null,
      min: null,
      max: null,
      counts: Object.fromEntries(keys.map((k) => [k, 0])),
      meanWeights: Object.fromEntries(keys.map((k) => [k, 0])),
      atLeastHalf: 0,
    };
  }
  for (const row of report.rows) {
    totals[row.status]++;
    if (row.status !== "success" || !row.result) continue;
    for (const [id, answer] of Object.entries(row.result.response.answers)) {
      const summary = criteria[id];
      summary.count++;
      if (answer.type === "choice") summary.counts[answer.choice]++;
      else {
        const value = answer.type === "score" ? answer.score : answer.noul;
        summary.mean = (summary.mean ?? 0) + value;
        summary.min =
          summary.min === null ? value : Math.min(summary.min, value);
        summary.max =
          summary.max === null ? value : Math.max(summary.max, value);
        if (answer.type === "noul" && value >= 0.5) summary.atLeastHalf++;
      }
      if (answer.type !== "noul")
        for (const [key, weight] of Object.entries(answer.probabilities))
          summary.meanWeights[key] += weight;
    }
  }
  for (const summary of Object.values(criteria)) {
    if (!summary.count) continue;
    if (summary.mean !== null) summary.mean /= summary.count;
    for (const key of Object.keys(summary.meanWeights))
      summary.meanWeights[key] /= summary.count;
  }
  return { totals, criteria };
}
// Prevent spreadsheet applications from interpreting user text as formulas.
export function toCsv(rows: (string | number)[][]): string {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = String(value);
            if (typeof value === "string" && /^[\s\uFEFF]*[=+@-]/.test(text))
              text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
          })
          .join(","),
      )
      .join("\r\n")
  );
}
