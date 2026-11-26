// ガントの書き出し（CSV）。画面に読み込み済みの行（絞り込み・チーム指定・並び順を反映した
// dto.rows）をそのまま表にする。折りたたみで隠れた子も含める。作りは運営名簿の書き出し
// (fe2-app-shell/src/features/members/rosterExport.ts) に合わせ、外部ライブラリは使わない。
import type { common, gantt, task } from "@dub/types";
import { STATUS_LABEL, dateInputFromIso } from "./task-form";
import type { ChildProgress } from "./child-progress";

export interface GanttExportTable {
  headers: string[];
  rows: string[][];
}

export interface GanttExportContext {
  numberById?: ReadonlyMap<common.TaskId, string>;
  /** 表示上の状態（親は子からの集計値）。 */
  statusById?: ReadonlyMap<common.TaskId, task.TaskStatus>;
  childProgressById?: ReadonlyMap<common.TaskId, ChildProgress>;
  assigneeNameById?: ReadonlyMap<common.TaskId, string>;
  teamNameById?: ReadonlyMap<string, string>;
}

export const GANTT_EXPORT_HEADERS = [
  "タスク番号", "タスク名", "親タスク", "チーム", "担当", "開始日", "終了日", "状態", "進捗(%)",
];

/** rows は親の期間を子から集計済み（rollupRowDates 後）のものを渡す。 */
export function buildGanttTable(rows: readonly gantt.GanttRow[], ctx: GanttExportContext = {}): GanttExportTable {
  const titleById = new Map(rows.map((r) => [r.taskId, r.title] as const));
  const out = rows.map((r) => {
    const status = ctx.statusById?.get(r.taskId);
    const prog = ctx.childProgressById?.get(r.taskId);
    const percent = prog ? prog.donePercent : status === "done" ? 100 : r.progressPercent;
    return [
      ctx.numberById?.get(r.taskId) ?? "",
      r.title,
      r.parentTaskId ? titleById.get(r.parentTaskId) ?? "" : "",
      r.teamId ? ctx.teamNameById?.get(r.teamId) ?? "" : "",
      ctx.assigneeNameById?.get(r.taskId) ?? "",
      dateInputFromIso(r.startsAt) ?? "",
      dateInputFromIso(r.endsAt) ?? "",
      status ? STATUS_LABEL[status] : "",
      String(percent),
    ];
  });
  return { headers: [...GANTT_EXPORT_HEADERS], rows: out };
}

// 表計算ソフトでの数式解釈(CSV injection)を防ぐ。
function neutralizeFormula(v: string): string {
  return /^[=@\t\r]/.test(v) || /^[+-][^\d\s]/.test(v) ? `'${v}` : v;
}

function csvCell(v: string): string {
  const s = neutralizeFormula(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel で文字化けしないよう UTF-8 BOM 付き・CRLF 改行。 */
export function toGanttCsv(t: GanttExportTable): string {
  return "﻿" + [t.headers, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function ganttCsvFileName(now = new Date()): string {
  return `ガント_${stamp(now)}.csv`;
}

export function downloadGanttCsv(t: GanttExportTable, now = new Date()): void {
  const url = URL.createObjectURL(new Blob([toGanttCsv(t)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = ganttCsvFileName(now);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
