import { describe, expect, it } from "vitest";
import { HttpCommanderClient, TaskRunActiveError, formatEvent } from "./client.ts";

const claude = (data: unknown) => formatEvent({ type: "claude", data });

describe("formatEvent", () => {
  it("shows assistant text and tool calls instead of the bare event type", () => {
    expect(
      claude({
        type: "assistant",
        message: { content: [{ type: "text", text: "Let me check the README." }] },
      }),
    ).toBe("💬 Let me check the README.");
    expect(
      claude({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test\n  --run" } }],
        },
      }),
    ).toBe("🔧 Bash: pnpm test --run");
    expect(
      claude({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [] } }] },
      }),
    ).toBe("🔧 TodoWrite");
  });

  it("drops events with nothing readable", () => {
    expect(claude({ type: "system", subtype: "thinking_tokens" })).toBe("");
    expect(claude({ type: "system", subtype: "init", cwd: "/x" })).toBe("");
    expect(claude({ type: "rate_limit_event" })).toBe("");
    expect(
      claude({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }),
    ).toBe("");
    expect(
      claude({
        type: "user",
        message: { content: [{ type: "tool_result", content: "file body" }] },
      }),
    ).toBe("");
  });

  it("surfaces failed tool results and the final result", () => {
    expect(
      claude({
        type: "user",
        message: {
          content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "boom\nmore" }] }],
        },
      }),
    ).toBe("⚠ boom more");
    expect(claude({ type: "result", subtype: "success", result: "done" })).toBe("✅ done");
    expect(claude({ type: "result", subtype: "error_max_turns" })).toBe("❌ error_max_turns");
  });

  it("keeps non-claude events as before", () => {
    expect(formatEvent({ type: "status", status: "running" })).toBe("● status: running");
    expect(formatEvent({ type: "exit", code: 0 })).toBe("exit code: 0");
  });
});

describe("HttpCommanderClient.startRun", () => {
  const capture = (status: number) => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ runId: "r1" }), { status });
    }) as unknown as typeof fetch;
    return { calls, client: new HttpCommanderClient("http://d", undefined, fetchImpl) };
  };

  it("sends taskId + taskContext so the daemon can open the task's own session", async () => {
    const { calls, client } = capture(201);
    await client.startRun("p", { taskId: "t1", taskContext: "[このタスク]" });
    expect(calls[0]!.body).toEqual({ prompt: "p", taskId: "t1", taskContext: "[このタスク]" });
  });

  it("maps 409 (task already running) to a readable error", async () => {
    const { client } = capture(409);
    await expect(client.startRun("p", { taskId: "t1" })).rejects.toBeInstanceOf(TaskRunActiveError);
  });
});
