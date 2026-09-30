import {
  CriteriaEditor,
  buildInput,
  type CriterionDraft,
  type Presentation,
} from "./criteria-editor";
import {
  MAX_BATCH_BYTES,
  lineItems,
  parseTable,
  tableItems,
  newBatch,
  runBatch,
  summarizeBatch,
  toCsv,
  type BatchItem,
  type BatchReport,
  type BatchRow,
} from "../../features/jev/batch";
import { asJevError, type Answer } from "../../features/jev/types";
import type { DecisionSession } from "../../inference/decision-session";
import { readImage, validateImageFiles } from "../../features/jev/images";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(`batch-${id}`) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
};
const statusNames = {
  pending: "未処理",
  running: "判定中",
  success: "完了",
  error: "失敗",
  cancelled: "中止",
};
const format = (n: number | null) =>
  n === null ? "—" : String(Number(n.toFixed(3)));
function answerText(answer: Answer): string {
  return answer.type === "choice"
    ? answer.choice
    : answer.type === "score"
      ? `${format(answer.score)} 点`
      : `${format(answer.noul * 100)}%`;
}
export class BatchPage {
  busy = false;
  private initialized = false;
  private reading = false;
  private controller?: AbortController;
  private editor: CriteriaEditor;
  private report?: BatchReport;
  private presentation: Presentation = {};
  private parsed: string[][] = [];
  private items: BatchItem[] = [];
  private imageFiles: File[] = [];
  private imageUrls: string[] = [];
  private runImages: File[] = [];
  private runImageUrls: string[] = [];
  private page = 0;
  private lastRender = 0;
  private ready = false;
  constructor(
    private options: {
      session: DecisionSession;
      getCriteria(): CriterionDraft[];
      setBusy(busy: boolean): void;
      canStart(): boolean;
    },
  ) {
    this.editor = new CriteriaEditor($("criteria"), () => this.changed());
    $("copy-criteria").onclick = () => {
      this.copyCriteria();
      this.changed();
    };
    $("add-criterion").onclick = () => {
      if ($("criteria").children.length < 16) this.editor.add();
      this.changed();
    };
    $("source").addEventListener("input", () => {
      this.parsed = [];
      this.changed();
    });
    $("format").addEventListener("change", () => {
      this.parsed = [];
      this.changed();
    });
    for (const id of ["header", "content-column", "name-column"])
      $(id).addEventListener("change", () => {
        if (id === "header") this.parsed = [];
        this.attempt(() => this.preview());
        this.changed();
      });
    $("preview-button").onclick = () => this.attempt(() => this.preview());
    $("file").addEventListener("change", () => void this.readFile());
    $("images").addEventListener("change", () =>
      this.attempt(() => {
        const picker = $<HTMLInputElement>("images");
        const files = Array.from(picker.files ?? []);
        picker.value = "";
        if (this.busy || !files.length) return;
        if (files.length > 10)
          throw new Error("画像の一括判定は10枚までです。");
        for (const file of files) validateImageFiles([file]);
        this.imageUrls.forEach((url) => URL.revokeObjectURL(url));
        this.imageFiles = files;
        this.imageUrls = files.map((file) => URL.createObjectURL(file));
        this.changed();
        this.preview();
      }),
    );
    $("image-text").addEventListener("input", () => {
      this.changed();
      this.preview();
    });
    $("sample").onclick = () => {
      $<HTMLSelectElement>("format").value = "table";
      $<HTMLInputElement>("header").checked = true;
      $<HTMLTextAreaElement>("source").value =
        "名前,内容\n問い合わせ1,同じ注文が二度請求されました。返金してください。\n問い合わせ2,荷物がまだ届きません。配送状況を教えてください。\n問い合わせ3,営業時間を教えてください。";
      this.parsed = [];
      this.preview();
      this.changed();
    };
    $("run").onclick = () => void this.start(false);
    $("resume").onclick = () => void this.start(true);
    $("cancel").onclick = () => {
      this.controller?.abort();
      $<HTMLButtonElement>("cancel").disabled = true;
      $("progress-text").textContent =
        "中止処理中です。完了済みの結果は残します。";
    };
    for (const id of ["filter", "search"])
      $(id).addEventListener("input", () => {
        this.page = 0;
        this.renderRows();
      });
    $("previous").onclick = () => {
      this.page--;
      this.renderRows();
    };
    $("next").onclick = () => {
      this.page++;
      this.renderRows();
    };
    for (const id of ["csv", "summary-csv", "json"])
      $(id).onclick = () => this.export(id);
  }
  enter() {
    if (this.initialized) return;
    this.initialized = true;
    this.copyCriteria();
    this.changed();
  }
  private copyCriteria() {
    $("criteria").replaceChildren();
    for (const draft of this.options.getCriteria())
      this.editor.add(structuredClone(draft));
  }
  private changed() {
    $("columns").hidden = value("format") !== "table";
    $("text-input").hidden = value("format") === "images";
    $("image-input").hidden = value("format") !== "images";
    $<HTMLButtonElement>("add-criterion").disabled =
      $("criteria").children.length >= 16;
    $("criteria-count").textContent = `${$("criteria").children.length}件`;
    $("input-note").textContent = this.report
      ? "入力の変更は次に「新しく一括判定」を押すと使います。表示中の結果と再開には、開始時のデータ・判定基準を使います。"
      : "取り込み内容を確認してから判定してください。空の行は取り込みません。";
  }
  refreshSession(ready: boolean, label: string) {
    this.ready = ready;
    $("model").textContent = label;
    this.controls();
  }
  private controls() {
    const locked = this.busy || this.reading;
    $<HTMLFieldSetElement>("input-fields").disabled = locked;
    $<HTMLFieldSetElement>("criteria-fields").disabled = locked;
    $<HTMLButtonElement>("run").disabled = locked || !this.ready;
    $<HTMLButtonElement>("resume").disabled =
      locked ||
      !this.ready ||
      !this.report ||
      this.report.model.generation !==
        this.options.session.loaded?.generation ||
      !this.report.rows.some((row) => row.status !== "success");
    $<HTMLButtonElement>("cancel").disabled =
      !this.busy || !!this.controller?.signal.aborted;
    for (const id of ["csv", "summary-csv", "json"])
      $<HTMLButtonElement>(id).disabled = !this.report;
  }
  private attempt(fn: () => void) {
    $("error").hidden = true;
    try {
      fn();
    } catch (error) {
      this.showError(error);
    }
  }
  private showError(error: unknown) {
    $("error").hidden = false;
    $("error").textContent = asJevError(error).message;
  }
  private async readFile() {
    const picker = $<HTMLInputElement>("file"),
      file = picker.files?.[0];
    picker.value = "";
    if (!file || this.busy || this.reading) return;
    this.reading = true;
    this.controls();
    $("error").hidden = true;
    try {
      if (file.size > MAX_BATCH_BYTES)
        throw new Error("取り込めるファイルは20 MiBまでです。");
      const source = new TextDecoder(value("encoding"), { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      $<HTMLTextAreaElement>("source").value = source;
      $<HTMLSelectElement>("format").value = /\.(csv|tsv)$/i.test(file.name)
        ? "table"
        : "lines";
      this.parsed = [];
      this.changed();
      this.preview();
    } catch (error) {
      this.showError(error);
    } finally {
      this.reading = false;
      this.controls();
    }
  }
  private preview() {
    if (value("format") === "images")
      this.items = this.imageFiles.map((file, i) => ({
        number: i + 1,
        name: file.name,
        text: value("image-text"),
        image: { name: file.name, type: file.type, size: file.size },
      }));
    else if (value("format") === "lines")
      this.items = lineItems(value("source"));
    else {
      if (!this.parsed.length) {
        this.parsed = parseTable(value("source"));
        const headers = this.parsed[0] ?? [];
        const hasHeader = $<HTMLInputElement>("header").checked;
        const content = $<HTMLSelectElement>("content-column"),
          name = $<HTMLSelectElement>("name-column");
        content.replaceChildren(new Option("行全体を使う", "-1"));
        name.replaceChildren(new Option("連番を使う", "-1"));
        headers.forEach((text, i) => {
          const title = `${i + 1}列目${hasHeader ? "：" + text.slice(0, 80) : ""}`;
          content.add(new Option(title, String(i)));
          name.add(new Option(title, String(i)));
        });
        const contentIndex = hasHeader
          ? headers.findIndex((h) =>
              /^(内容|本文|文章|text|content|state|message)$/i.test(h.trim()),
            )
          : 0;
        const nameIndex = hasHeader
          ? headers.findIndex((h) =>
              /^(名前|件名|番号|タイトル|id|name|title)$/i.test(h.trim()),
            )
          : -1;
        content.value = String(contentIndex);
        name.value = String(nameIndex);
      }
      this.items = tableItems(
        this.parsed,
        $<HTMLInputElement>("header").checked,
        Number(value("content-column")),
        Number(value("name-column")),
      );
    }
    $("input-count").textContent =
      `${this.items.length.toLocaleString()}件（先頭10件を表示）`;
    const body = $("preview");
    body.replaceChildren();
    for (const item of this.items.slice(0, 10)) {
      const row = node("tr"),
        content = node("td", item.text.slice(0, 300));
      if (item.image) {
        const img = node("img");
        img.src = this.imageUrls[item.number - 1];
        img.alt = item.name;
        content.prepend(img);
      }
      row.append(
        node("td", String(item.number)),
        node("td", item.name),
        content,
      );
      body.append(row);
    }
  }
  private async start(resume: boolean) {
    if (this.busy || this.reading || !this.options.canStart()) return;
    $("error").hidden = true;
    try {
      if (resume) {
        if (
          !this.report ||
          this.report.model.generation !==
            this.options.session.loaded?.generation
        )
          throw new Error(
            "再開するには、開始時と同じモデルを読み込んだままにしてください。変更した場合は新しく一括判定してください。",
          );
      } else {
        this.preview();
        if (
          this.items.some((item) => item.image) &&
          !this.options.session.loaded?.supports_images
        )
          throw new Error(
            "画像の一括判定には、画像対応モデルと画像用ファイルを読み込んでください。",
          );
        const { input, presentation } = buildInput(
          "判定対象",
          this.editor.read(),
        );
        this.report = newBatch(
          this.items,
          input.questions,
          this.options.session.loaded!,
        );
        this.runImages =
          value("format") === "images" ? [...this.imageFiles] : [];
        this.runImageUrls.forEach((url) => URL.revokeObjectURL(url));
        this.runImageUrls = this.runImages.map((file) =>
          URL.createObjectURL(file),
        );
        this.presentation = structuredClone(presentation);
        this.page = 0;
      }
      this.busy = true;
      this.controller = new AbortController();
      this.options.setBusy(true);
      this.controls();
      this.render();
      await runBatch(
        this.report!,
        async (input, signal, row) => {
          const images = row.image
            ? [await readImage(this.runImages[row.number - 1])]
            : [];
          signal.throwIfAborted();
          return this.options.session.evaluate(input, signal, images);
        },
        this.controller.signal,
        () => {
          if (performance.now() - this.lastRender > 150) this.render();
        },
      );
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
      this.controller = undefined;
      this.options.setBusy(false);
      this.controls();
      this.render();
    }
  }
  private render() {
    if (!this.report) return;
    this.lastRender = performance.now();
    const { totals, criteria } = summarizeBatch(this.report);
    const processed = totals.success + totals.error;
    $<HTMLProgressElement>("progress").max = totals.total;
    $<HTMLProgressElement>("progress").value = processed;
    $("progress-text").textContent =
      `${this.busy ? "判定中" : totals.pending || totals.cancelled ? "途中までの結果" : "判定終了"}：全${totals.total}件 / 完了 ${totals.success}件 / 失敗 ${totals.error}件 / 中止 ${totals.cancelled}件 / 未処理 ${totals.pending}件${totals.running ? " / 処理中 1件" : ""}`;
    $("summary-note").textContent =
      `集計対象は全基準の判定が完了した${totals.success}件です。失敗・中止・未処理は含みません。割合や当てはまりは正答率ではありません。`;
    $("summary").replaceChildren();
    for (const [id, summary] of Object.entries(criteria)) {
      const card = node("article");
      card.className = "batch-summary-card";
      card.append(
        node("h3", this.presentation[id].alias),
        node("p", `対象 ${summary.count}件`),
      );
      if (summary.type === "choice") {
        for (const [label, count] of Object.entries(summary.counts))
          card.append(
            node(
              "p",
              `${label}：${count}件（${summary.count ? format((count / summary.count) * 100) : "—"}%）`,
            ),
          );
      } else {
        const factor = summary.type === "noul" ? 100 : 1,
          unit = summary.type === "noul" ? "%" : "点";
        card.append(
          node(
            "strong",
            `平均 ${format(summary.mean === null ? null : summary.mean * factor)}${unit}`,
          ),
        );
        card.append(
          node(
            "p",
            `最小 ${format(summary.min === null ? null : summary.min * factor)} / 最大 ${format(summary.max === null ? null : summary.max * factor)}${unit}`,
          ),
        );
        if (summary.type === "noul")
          card.append(
            node(
              "p",
              `当てはまり50%以上：${summary.atLeastHalf}件 / 50%未満：${summary.count - summary.atLeastHalf}件`,
            ),
          );
        else
          for (const [level, weight] of Object.entries(summary.meanWeights))
            card.append(
              node(
                "p",
                `${this.presentation[id].labels[Number(level)]}：平均の重み ${summary.count ? format(weight * 100) : "—"}%`,
              ),
            );
      }
      $("summary").append(card);
    }
    this.renderRows();
    this.controls();
  }
  private renderRows() {
    if (!this.report) return;
    const search = value("search").toLocaleLowerCase(),
      filter = value("filter");
    const filtered = this.report.rows.filter(
      (row) =>
        (filter === "all" || row.status === filter) &&
        (!search ||
          `${row.name}\n${row.text}`.toLocaleLowerCase().includes(search)),
    );
    const pages = Math.max(1, Math.ceil(filtered.length / 50));
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    $("page-number").textContent =
      `${filtered.length}件 / ${this.page + 1} / ${pages}ページ`;
    $<HTMLButtonElement>("previous").disabled = this.page === 0;
    $<HTMLButtonElement>("next").disabled = this.page + 1 >= pages;
    const open = new Set(
      Array.from(
        $("rows").querySelectorAll<HTMLDetailsElement>("details[open]"),
      ).map((d) => d.dataset.number),
    );
    $("rows").replaceChildren();
    for (const row of filtered.slice(this.page * 50, this.page * 50 + 50)) {
      const tr = node("tr");
      tr.className = "batch-result-row";
      tr.append(
        node("td", String(row.number)),
        node("td", row.name),
        node("td", statusNames[row.status]),
      );
      const result = node("td");
      if (row.result)
        for (const [id, answer] of Object.entries(row.result.response.answers))
          result.append(
            node(
              "div",
              `${this.presentation[id].alias}：${answerText(answer)}`,
            ),
          );
      else
        result.textContent = row.error
          ? `${row.error.question ? this.presentation[row.error.question]?.alias + "：" : ""}${row.error.message}`
          : "—";
      tr.append(result);
      const detailCell = node("td"),
        details = node("details");
      details.dataset.number = String(row.number);
      details.open = open.has(String(row.number));
      details.append(node("summary", "内容と判定の内訳"));
      if (row.image) {
        const preview = node("img");
        preview.src = this.runImageUrls[row.number - 1];
        preview.alt = row.image.name;
        details.append(preview);
      }
      const text = node("p", row.text);
      text.className = "batch-input-text";
      details.append(text);
      if (row.result) {
        details.append(node("p", `使用モデル：${row.result.response.model}`));
        if (row.result.diagnostics.fallback)
          details.append(
            node(
              "p",
              `ローカルへフォールバック：${row.result.diagnostics.fallback.reason}`,
            ),
          );
      }
      if (row.result)
        for (const [id, answer] of Object.entries(
          row.result.response.answers,
        )) {
          details.append(
            node("h4", `${this.presentation[id].alias}：${answerText(answer)}`),
          );
          if (answer.type !== "noul") {
            for (const [key, weight] of Object.entries(answer.probabilities))
              details.append(
                node(
                  "p",
                  `${answer.type === "score" ? this.presentation[id].labels[Number(key)] : key}：${format(weight * 100)}%`,
                ),
              );
            details.append(
              node("p", `重みの集中度：${format(answer.confidence * 100)}%`),
            );
          }
        }
      detailCell.append(details);
      tr.append(detailCell);
      $("rows").append(tr);
    }
  }
  private export(kind: string) {
    if (!this.report) return;
    const summary = summarizeBatch(this.report);
    let content: string;
    if (kind === "json")
      content = JSON.stringify(
        { ...this.report, presentation: this.presentation, summary },
        null,
        2,
      );
    else if (kind === "csv") {
      const ids = Object.keys(this.report.questions);
      const headers = [
        "番号",
        "データ名",
        "内容",
        "画像ファイル",
        "状態",
        "エラー",
      ];
      for (const [i, id] of ids.entries()) {
        headers.push(`${i + 1}. ${this.presentation[id].alias}`);
        if (this.report.questions[id].type !== "noul")
          headers.push(`${i + 1}. 重みの集中度（0〜1）`);
      }
      content = toCsv([
        headers,
        ...this.report.rows.map((row) => {
          const cells: (string | number)[] = [
            row.number,
            row.name,
            row.text,
            row.image?.name ?? "",
            statusNames[row.status],
            row.error?.message ?? "",
          ];
          for (const id of ids) {
            const answer = row.result?.response.answers[id];
            cells.push(
              !answer
                ? ""
                : answer.type === "choice"
                  ? answer.choice
                  : answer.type === "score"
                    ? answer.score
                    : `${answer.noul * 100}%`,
            );
            if (this.report!.questions[id].type !== "noul")
              cells.push(
                answer && answer.type !== "noul" ? answer.confidence : "",
              );
          }
          return cells;
        }),
      ]);
    } else {
      const rows: (string | number)[][] = [
        ["基準名", "集計項目", "ラベル", "値", "対象件数"],
      ];
      for (const [id, s] of Object.entries(summary.criteria)) {
        const name = this.presentation[id].alias;
        if (s.type === "choice")
          for (const [label, count] of Object.entries(s.counts)) {
            rows.push(
              [name, "件数", label, count, s.count],
              [
                name,
                "割合（%）",
                label,
                s.count ? (count / s.count) * 100 : "",
                s.count,
              ],
            );
          }
        else {
          rows.push(
            [
              name,
              s.type === "noul" ? "平均（%）" : "平均点",
              "",
              s.mean === null ? "" : s.mean * (s.type === "noul" ? 100 : 1),
              s.count,
            ],
            [
              name,
              s.type === "noul" ? "最小（%）" : "最小点",
              "",
              s.min === null ? "" : s.min * (s.type === "noul" ? 100 : 1),
              s.count,
            ],
            [
              name,
              s.type === "noul" ? "最大（%）" : "最大点",
              "",
              s.max === null ? "" : s.max * (s.type === "noul" ? 100 : 1),
              s.count,
            ],
          );
          if (s.type === "score")
            for (const [level, weight] of Object.entries(s.meanWeights))
              rows.push([
                name,
                "平均の重み（%）",
                this.presentation[id].labels[Number(level)],
                s.count ? weight * 100 : "",
                s.count,
              ]);
          else
            rows.push([
              name,
              "当てはまり50%以上の件数",
              "",
              s.atLeastHalf,
              s.count,
            ]);
        }
      }
      content = toCsv(rows);
    }
    const url = URL.createObjectURL(
      new Blob([content], {
        type: kind === "json" ? "application/json" : "text/csv;charset=utf-8",
      }),
    );
    const a = node("a");
    a.href = url;
    a.download = `jevwex-batch-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.${kind === "json" ? "json" : "csv"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  dispose() {
    this.controller?.abort();
    this.runImageUrls.forEach((url) => URL.revokeObjectURL(url));
    this.imageUrls.forEach((url) => URL.revokeObjectURL(url));
  }
}
