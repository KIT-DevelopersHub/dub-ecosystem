// Readable run log for the task drawer. A finished run leads with its final report
// (rendered Markdown) and tucks the working log behind a toggle; the working log itself
// shows the agent's prose as Markdown and folds consecutive tool calls into one row, so
// the dozens of 🔧 lines at the start of a run no longer bury what the agent said.
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { LogEntry } from "./lib/client.ts";
import { Markdown } from "./Markdown.tsx";
import { t } from "./lib/theme.ts";

type Row =
  | { kind: "text"; text: string }
  | { kind: "tools"; entries: LogEntry[] }
  | { kind: "line"; text: string; tone: "muted" | "danger" };

const TOOLISH = new Set<LogEntry["kind"]>(["tool", "warn"]);

/** Drop bookkeeping noise and fold consecutive tool calls; `report` is not repeated. */
export function toRows(entries: LogEntry[], report: string | null): Row[] {
  const rows: Row[] = [];
  for (const e of entries) {
    if (e.kind === "status" || e.kind === "result") continue;
    if (e.kind === "exit" && e.code === 0) continue;
    if (e.kind === "text" && report !== null && e.text === report.trim()) continue;
    if (TOOLISH.has(e.kind)) {
      const last = rows[rows.length - 1];
      if (last?.kind === "tools") last.entries.push(e);
      else rows.push({ kind: "tools", entries: [e] });
      continue;
    }
    if (e.kind === "text") rows.push({ kind: "text", text: e.text });
    else if (e.kind === "exit") rows.push({ kind: "line", tone: "danger", text: `exit code: ${e.text}` });
    else if (e.kind === "error") rows.push({ kind: "line", tone: "danger", text: `error: ${e.text}` });
    else if (e.kind === "stderr") rows.push({ kind: "line", tone: "muted", text: `stderr> ${e.text}` });
    else rows.push({ kind: "line", tone: "muted", text: e.text });
  }
  return rows;
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

const s = {
  box: {
    padding: t.space3,
    borderRadius: t.radius,
    border: `1px solid ${t.border}`,
    background: t.sunken,
  } as CSSProperties,
  scroll: { maxHeight: "48vh", overflow: "auto" } as CSSProperties,
  toolLine: {
    fontFamily: mono,
    fontSize: 11.5,
    color: t.textMuted,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } as CSSProperties,
  summary: { cursor: "pointer", fontSize: 12, color: t.textMuted, padding: `${t.space1} 0` } as CSSProperties,
  sectionLabel: { fontSize: 12, fontWeight: 700, color: t.textMuted, marginBottom: t.space2 } as CSSProperties,
};

function ToolGroup({ entries }: { entries: LogEntry[] }) {
  const tools = entries.filter((e) => e.kind === "tool");
  const errors = entries.length - tools.length;
  const latest = tools[tools.length - 1]?.text ?? entries[entries.length - 1]!.text;
  return (
    <details data-testid="log-tools" style={{ margin: `${t.space1} 0 ${t.space3}` }}>
      <summary style={{ ...s.summary, ...s.toolLine, display: "list-item" }}>
        🔧 {tools.length} 件の操作{errors > 0 && <span style={{ color: t.warning }}>（エラー {errors}）</span>}
        {" — "}
        {latest.replace(/^🔧\s*/, "")}
      </summary>
      <div style={{ paddingLeft: t.space4, display: "flex", flexDirection: "column", gap: 2 }}>
        {entries.map((e, i) => (
          <div key={i} title={e.text} style={{ ...s.toolLine, color: e.kind === "warn" ? t.warning : t.textMuted }}>
            {e.kind === "warn" ? `⚠ ${e.text}` : e.text}
          </div>
        ))}
      </div>
    </details>
  );
}

function WorkLog({ rows, follow }: { rows: Row[]; follow: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow && followRef.current) el.scrollTop = el.scrollHeight;
  });
  if (rows.length === 0) {
    return <div style={{ fontSize: 12, color: t.textMuted }}>（ログはまだありません）</div>;
  }
  return (
    <div
      ref={ref}
      data-testid="drawer-worklog"
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      style={s.scroll}
    >
      {rows.map((r, i) =>
        r.kind === "text" ? (
          <Markdown key={i} text={r.text} />
        ) : r.kind === "tools" ? (
          <ToolGroup key={i} entries={r.entries} />
        ) : (
          <div
            key={i}
            style={{
              fontFamily: mono,
              fontSize: 11.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: r.tone === "danger" ? t.danger : t.textMuted,
              marginBottom: t.space1,
            }}
          >
            {r.text}
          </div>
        ),
      )}
    </div>
  );
}

export function RunLog({ entries }: { entries: LogEntry[] }) {
  const result = [...entries].reverse().find((e) => e.kind === "result");
  const report = result?.kind === "result" ? result : null;
  const rows = toRows(entries, report?.text ?? null);

  if (!report) {
    return (
      <div data-testid="drawer-log" style={s.box}>
        <WorkLog rows={rows} follow />
      </div>
    );
  }
  return (
    <div data-testid="drawer-log" style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <section>
        <div style={{ ...s.sectionLabel, color: report.ok ? t.success : t.danger }}>
          {report.ok ? "✅ 実行結果" : "❌ 実行結果（失敗）"}
        </div>
        <div style={s.box}>
          <Markdown text={report.text} testId="drawer-result" />
        </div>
      </section>
      <details data-testid="drawer-worklog-toggle" style={s.box}>
        <summary style={{ ...s.summary, fontWeight: 600 }}>作業ログを表示（{rows.length} 件）</summary>
        <div style={{ marginTop: t.space3 }}>
          <WorkLog rows={rows} follow={false} />
        </div>
      </details>
    </div>
  );
}
