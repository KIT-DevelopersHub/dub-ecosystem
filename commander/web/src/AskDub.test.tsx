import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AskDub } from "./AskDub.tsx";
import { makeFakeClient } from "./test/fakes.ts";
import { DUB_ECOSYSTEM_CWD } from "./lib/askDub.ts";
import type { DaemonRunEvent } from "./lib/client.ts";

const answerFlow: DaemonRunEvent[] = [
  { type: "status", status: "running" },
  { type: "claude", data: { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "calendar" } }] } } },
  { type: "claude", data: { type: "result", subtype: "success", result: "カレンダーは apps/fe9-calendar にあります。" } },
  { type: "status", status: "succeeded" },
];

describe("<AskDub>", () => {
  beforeEach(() => localStorage.clear());

  it("shows sample questions when empty", () => {
    render(<AskDub client={makeFakeClient()} seed={[]} />);
    expect(screen.getAllByTestId("askdub-sample").length).toBeGreaterThan(0);
  });

  it("asks a question against dub-ecosystem and streams the answer", async () => {
    const client = makeFakeClient(answerFlow);
    render(<AskDub client={client} seed={[]} />);

    fireEvent.change(screen.getByTestId("askdub-input"), {
      target: { value: "カレンダーはどこ?" },
    });
    fireEvent.click(screen.getByTestId("askdub-send"));

    // Question echoed, answer resolved from the result event.
    expect(await screen.findByText("カレンダーはどこ?")).toBeInTheDocument();
    expect(await screen.findByText(/apps\/fe9-calendar/)).toBeInTheDocument();

    // Ran in the dub-ecosystem repo (read-only Q&A), not a task worktree.
    expect(client.startRun).toHaveBeenCalledWith(
      expect.stringContaining("質問: カレンダーはどこ?"),
      { cwd: DUB_ECOSYSTEM_CWD },
    );
    // Tool activity captured.
    expect(await screen.findByText(/調べたもの/)).toBeInTheDocument();
  });

  it("re-injects prior turns into a follow-up prompt", async () => {
    const client = makeFakeClient(answerFlow);
    render(<AskDub client={client} seed={[]} />);

    fireEvent.change(screen.getByTestId("askdub-input"), { target: { value: "最初の質問" } });
    fireEvent.click(screen.getByTestId("askdub-send"));
    await screen.findByText(/apps\/fe9-calendar/);

    fireEvent.change(screen.getByTestId("askdub-input"), { target: { value: "その続きは?" } });
    fireEvent.click(screen.getByTestId("askdub-send"));

    await waitFor(() => {
      const followup = client.startRun.mock.calls[1]?.[0] as string;
      expect(followup).toContain("これまでの会話");
      expect(followup).toContain("最初の質問");
      expect(followup).toContain("質問: その続きは?");
    });
  });
});
