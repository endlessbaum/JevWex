import {
  JevError,
  type JevInput,
  type Question,
  type Description,
} from "../../features/jev/types";
import { validateRequest } from "../../features/jev/validate";

export interface LabelDraft {
  label: string;
  description: string;
}
export interface CriterionDraft {
  id: string;
  alias: string;
  type: Question["type"];
  instructions: string;
  labels: LabelDraft[];
}
export type Presentation = Record<string, { alias: string; labels: string[] }>;
export const typeNames = {
  choice: "選択式",
  score: "段階評価",
  noul: "当てはまり",
};
const aliases: Record<string, string> = {
  department: "担当窓口",
  requests_refund: "返金の希望",
  request_specificity: "対応の具体性",
  genre: "記事のジャンル",
  has_place: "会場の記載",
  detail: "案内の詳しさ",
};
export function readable(value: Description | null): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((v) =>
        typeof v === "object" && v !== null
          ? readable(v as Description)
          : String(v ?? ""),
      )
      .join("\n");
  return Object.entries(value)
    .map(
      ([k, v]) =>
        `${k}：${typeof v === "object" && v !== null ? readable(v as Description) : String(v ?? "")}`,
    )
    .join("\n");
}
export function draftFromQuestion(id: string, q: Question): CriterionDraft {
  const labels =
    q.type === "choice"
      ? Object.entries(q.criteria).map(([label, description]) => ({
          label,
          description: readable(description),
        }))
      : q.type === "score"
        ? q.criteria.map((description, i) => ({
            label: `段階${i}`,
            description: readable(description),
          }))
        : [];
  return {
    id,
    alias: aliases[id] ?? id,
    type: q.type,
    instructions: readable(q.instructions),
    labels,
  };
}
export function buildInput(
  text: string,
  drafts: CriterionDraft[],
): { input: JevInput; presentation: Presentation } {
  const fail = (message: string): never => {
    throw new JevError("INVALID_REQUEST", message);
  };
  if (!text.trim()) fail("判定する文章を入力してください。");
  if (!drafts.length || drafts.length > 16)
    fail("判定基準は1〜16件にしてください。");
  const questions: Record<string, Question> = Object.create(null);
  const presentation: Presentation = Object.create(null);
  for (const draft of drafts) {
    const alias = draft.alias.trim();
    if (!alias) fail("基準名を入力してください。");
    if (!draft.instructions.trim())
      fail(`「${alias}」の判定する内容・条件を入力してください。`);
    if (Object.hasOwn(questions, draft.id))
      fail("判定基準が重複しています。基準を追加し直してください。");
    const labels = draft.labels.map((l) => ({
      label: l.label.trim(),
      description: l.description.trim(),
    }));
    if (draft.type !== "noul") {
      const max = draft.type === "choice" ? 32 : 10;
      if (labels.length < 2 || labels.length > max)
        fail(
          `「${alias}」の${draft.type === "choice" ? "選択肢" : "段階"}は2〜${max}件にしてください。`,
        );
      if (labels.some((l) => !l.label))
        fail(`「${alias}」のラベルを入力してください。`);
      if (new Set(labels.map((l) => l.label)).size !== labels.length)
        fail(
          `「${alias}」のラベルが重複しています。別の名前を付けてください。`,
        );
    }
    questions[draft.id] =
      draft.type === "choice"
        ? {
            type: "choice",
            instructions: draft.instructions,
            criteria: Object.fromEntries(
              labels.map((l) => [l.label, l.description]),
            ),
          }
        : draft.type === "score"
          ? {
              type: "score",
              instructions: draft.instructions,
              criteria: labels.map((l) => ({
                label: l.label,
                description: l.description,
              })),
            }
          : { type: "noul", instructions: draft.instructions };
    presentation[draft.id] = { alias, labels: labels.map((l) => l.label) };
  }
  const input = { state: text, questions };
  if (JSON.stringify(input).length > 65536)
    fail(
      "入力が長すぎます。文章や判定基準を短くしてください（合計65,536文字まで）。",
    );
  return { input: validateRequest(input), presentation };
}

export class CriteriaEditor {
  constructor(
    private host: HTMLElement,
    private changed: () => void,
  ) {}
  populate(input: JevInput) {
    this.host.replaceChildren();
    for (const [id, q] of Object.entries(input.questions))
      this.add(draftFromQuestion(id, q));
  }
  read(): CriterionDraft[] {
    return Array.from(this.host.children).map((row) => {
      const get = (field: string) =>
        (row.querySelector(`[data-field="${field}"]`) as HTMLInputElement)
          .value;
      return {
        id: (row as HTMLElement).dataset.id!,
        alias: get("alias"),
        type: get("type") as Question["type"],
        instructions: get("instructions"),
        labels: this.readLabels(row),
      };
    });
  }
  private readLabels(row: Element): LabelDraft[] {
    return Array.from(row.querySelectorAll(".label-row")).map((l) => ({
      label: (l.querySelector('[data-field="label"]') as HTMLInputElement)
        .value,
      description: (
        l.querySelector('[data-field="description"]') as HTMLTextAreaElement
      ).value,
    }));
  }
  add(
    draft: CriterionDraft = {
      id: `criterion_${crypto.randomUUID()}`,
      alias: `判定基準${this.host.children.length + 1}`,
      type: "choice",
      instructions: "",
      labels: [
        { label: "選択肢1", description: "" },
        { label: "選択肢2", description: "" },
      ],
    },
  ) {
    const row = document.createElement("article");
    row.className = "criterion";
    row.dataset.id = draft.id;
    row.innerHTML = `<div class="criterion-heading"><label class="grow">基準名<input data-field="alias" placeholder="例：担当窓口"></label><label>判定方法<select data-field="type"><option value="choice">選択式</option><option value="score">段階評価</option><option value="noul">当てはまり</option></select></label><button class="icon danger remove-criterion" aria-label="この判定基準を削除" title="判定基準を削除">×</button></div><label class="instruction">判定する内容・条件<textarea data-field="instructions" rows="2" placeholder="文章や画像のどこを見て、何を判定するかを入力してください"></textarea></label><p class="instruction-example muted"></p><p class="criteria-hint muted"></p><div class="labels"></div><button class="add-label secondary" type="button">＋ ラベルを追加</button>`;
    const field = (name: string) =>
      row.querySelector(`[data-field="${name}"]`) as HTMLInputElement;
    field("alias").value = draft.alias;
    field("type").value = draft.type;
    field("instructions").value = draft.instructions;
    let current = draft.type;
    const saved: Partial<Record<Question["type"], LabelDraft[]>> = {
      [current]: draft.labels,
    };
    const renderLabels = (labels: LabelDraft[]) => {
      const host = row.querySelector(".labels")!;
      host.replaceChildren();
      row.querySelector(".instruction-example")!.textContent =
        current === "choice"
          ? "例：問い合わせの内容から、対応すべき窓口を選んでください。"
          : current === "score"
            ? "例：問い合わせに、希望する対応がどれだけ具体的に書かれているかを評価してください。"
            : "例：問い合わせの中で、返金を希望している。";
      row.querySelector(".criteria-hint")!.textContent =
        current === "choice"
          ? "最も合う選択肢を選びます。ラベルと、その選択肢に当てはまる内容を入力してください。"
          : current === "score"
            ? "上から低い段階 → 高い段階の順です。最初の段階を0として点数を計算します。"
            : "入力した条件にどのくらい当てはまるかを判定します。選択肢の入力は不要です。";
      const add = row.querySelector<HTMLButtonElement>(".add-label")!;
      add.hidden = current === "noul";
      add.disabled = labels.length >= (current === "choice" ? 32 : 10);
      add.textContent =
        current === "score" ? "＋ 段階を追加" : "＋ ラベルを追加";
      if (current === "noul") return;
      labels.forEach((label, i) => {
        const item = document.createElement("div");
        item.className = "label-row";
        item.innerHTML = `<span class="level-number"></span><label>ラベル<input data-field="label"></label><label>説明<textarea data-field="description" rows="2" placeholder="このラベルに当てはまる内容"></textarea></label><div class="label-actions"><button class="icon move-up" title="上へ移動" aria-label="上へ移動">↑</button><button class="icon move-down" title="下へ移動" aria-label="下へ移動">↓</button><button class="icon danger remove-label" title="このラベルを削除" aria-label="このラベルを削除">×</button></div>`;
        item.querySelector(".level-number")!.textContent =
          current === "score" ? String(i) : "•";
        item.querySelector<HTMLInputElement>('[data-field="label"]')!.value =
          label.label;
        item.querySelector<HTMLTextAreaElement>(
          '[data-field="description"]',
        )!.value = label.description;
        const remove = item.querySelector<HTMLButtonElement>(".remove-label")!;
        remove.disabled = labels.length <= 2;
        remove.onclick = () => {
          const next = this.readLabels(row);
          next.splice(i, 1);
          renderLabels(next);
          this.changed();
        };
        for (const [selector, delta] of [
          [".move-up", -1],
          [".move-down", 1],
        ] as const) {
          const button = item.querySelector<HTMLButtonElement>(selector)!;
          button.hidden = current !== "score";
          button.disabled = i + delta < 0 || i + delta >= labels.length;
          button.onclick = () => {
            const next = this.readLabels(row);
            [next[i], next[i + delta]] = [next[i + delta], next[i]];
            renderLabels(next);
            this.changed();
          };
        }
        host.append(item);
      });
    };
    row.querySelector<HTMLButtonElement>(".add-label")!.onclick = () => {
      const next = this.readLabels(row);
      next.push({
        label:
          current === "score"
            ? `段階${next.length}`
            : `選択肢${next.length + 1}`,
        description: "",
      });
      renderLabels(next);
      this.changed();
    };
    field("type").onchange = () => {
      saved[current] = this.readLabels(row);
      current = field("type").value as Question["type"];
      renderLabels(
        saved[current] ?? [
          { label: current === "score" ? "低い" : "選択肢1", description: "" },
          { label: current === "score" ? "高い" : "選択肢2", description: "" },
        ],
      );
      this.changed();
    };
    row.querySelector<HTMLButtonElement>(".remove-criterion")!.onclick = () => {
      row.remove();
      this.changed();
    };
    row.addEventListener("input", this.changed);
    renderLabels(draft.labels);
    this.host.append(row);
  }
}
