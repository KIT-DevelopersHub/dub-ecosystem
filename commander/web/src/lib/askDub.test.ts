import { describe, it, expect } from "vitest";
import {
  buildAskPrompt,
  buildTranscript,
  parseClaudeEvent,
  QA_SYSTEM_PREFIX,
} from "./askDub.ts";
import type { DaemonRunEvent } from "./client.ts";

describe("buildAskPrompt", () => {
  it("prepends the read-only Q&A framing and the question", () => {
    const p = buildAskPrompt("カレンダーはどこ?");
    expect(p.startsWith(QA_SYSTEM_PREFIX)).toBe(true);
    expect(p).toContain("読み取り専用");
    expect(p).toContain("質問: カレンダーはどこ?");
    expect(p).not.toContain("これまでの会話");
  });

  it("injects the prior transcript for follow-up questions", () => {
    const p = buildAskPrompt("その続きは?", "Q: 最初\n\nA: 回答");
    expect(p).toContain("これまでの会話");
    expect(p).toContain("A: 回答");
    expect(p).toContain("質問: その続きは?");
  });
});

describe("buildTranscript", () => {
  it("formats turns and bounds to the last maxTurns", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `t${i}`,
    }));
    const out = buildTranscript(turns, 4);
    expect(out).toContain("t9");
    expect(out).not.toContain("t5");
    expect(out.split("\n\n")).toHaveLength(4);
  });

  it("skips empty turns", () => {
    expect(buildTranscript([{ role: "user", text: "  " }])).toBe("");
  });
});

describe("parseClaudeEvent", () => {
  const claude = (data: unknown): DaemonRunEvent => ({ type: "claude", data });

  it("extracts assistant text blocks", () => {
    const out = parseClaudeEvent(
      claude({ type: "assistant", message: { content: [{ type: "text", text: "答え" }] } }),
    );
    expect(out).toEqual([{ kind: "text", text: "答え" }]);
  });

  it("describes tool_use blocks with a target", () => {
    const out = parseClaudeEvent(
      claude({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/App.tsx" } }] },
      }),
    );
    expect(out).toEqual([{ kind: "tool", label: "Read src/App.tsx" }]);
  });

  it("treats a result object as the authoritative final answer", () => {
    const out = parseClaudeEvent(claude({ type: "result", subtype: "success", result: "最終回答" }));
    expect(out).toEqual([{ kind: "result", text: "最終回答" }]);
  });

  it("surfaces errors as text", () => {
    expect(parseClaudeEvent({ type: "error", message: "boom" })).toEqual([
      { kind: "text", text: "\n[エラー] boom" },
    ]);
  });

  it("ignores non-content events (system init, status)", () => {
    expect(parseClaudeEvent(claude({ type: "system", subtype: "init" }))).toEqual([]);
    expect(parseClaudeEvent({ type: "status", status: "running" })).toEqual([]);
  });
});
