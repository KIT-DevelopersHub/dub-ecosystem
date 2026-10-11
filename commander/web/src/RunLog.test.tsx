import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LogEntry } from "./lib/client.ts";
import { RunLog, toRows } from "./RunLog.tsx";

const REPORT = "## 結論\n\n| 項目 | 結果 |\n|---|---|\n| demo | PASS |";

const finished: LogEntry[] = [
  { kind: "status", status: "running", text: "running" },
  { kind: "tool", text: "🔧 Bash: cat memory.md" },
  { kind: "tool", text: "🔧 Bash: git worktree add" },
  { kind: "warn", text: "Exit code 1" },
  { kind: "text", text: "**設計が固まりました**。" },
  { kind: "tool", text: "🔧 Write: a.ts" },
  { kind: "text", text: REPORT },
  { kind: "result", ok: true, text: REPORT },
  { kind: "status", status: "succeeded", text: "succeeded" },
  { kind: "exit", code: 0, text: "0" },
];

describe("toRows", () => {
  it("drops status/exit-0 noise, folds tool runs and skips the duplicated report", () => {
    const rows = toRows(finished, REPORT);
    expect(rows.map((r) => r.kind)).toEqual(["tools", "text", "tools"]);
    expect(rows[0]).toMatchObject({ kind: "tools", entries: [{}, {}, { kind: "warn" }] });
  });

  it("keeps a non-zero exit and errors visible", () => {
    const rows = toRows(
      [
        { kind: "exit", code: 1, text: "1" },
        { kind: "error", text: "spawn failed" },
      ],
      null,
    );
    expect(rows).toEqual([
      { kind: "line", tone: "danger", text: "exit code: 1" },
      { kind: "line", tone: "danger", text: "error: spawn failed" },
    ]);
  });
});

describe("RunLog", () => {
  it("leads a finished run with its report as Markdown and collapses the work log", () => {
    render(<RunLog entries={finished} />);
    const result = screen.getByTestId("drawer-result");
    expect(result.querySelector("h2")?.textContent).toBe("結論");
    expect(result.querySelector("table")).not.toBeNull();
    const toggle = screen.getByTestId("drawer-worklog-toggle") as HTMLDetailsElement;
    expect(toggle.open).toBe(false);
    // The report is shown once, not again inside the work log.
    expect(screen.getAllByRole("heading", { name: "結論" })).toHaveLength(1);
  });

  it("shows the live work log directly while the run has no result yet", () => {
    render(<RunLog entries={finished.slice(0, 6)} />);
    expect(screen.queryByTestId("drawer-result")).toBeNull();
    expect(screen.getByTestId("drawer-worklog")).toBeInTheDocument();
    expect(screen.getAllByTestId("log-tools")[0]!.textContent).toContain("2 件の操作");
    expect(screen.getByText("設計が固まりました").tagName).toBe("STRONG");
  });

  it("says so when there is nothing yet", () => {
    render(<RunLog entries={[{ kind: "status", status: "running", text: "running" }]} />);
    expect(screen.getByText("（ログはまだありません）")).toBeInTheDocument();
  });
});
