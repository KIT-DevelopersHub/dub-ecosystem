import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { OperateDub } from "./OperateDub.tsx";
import { makeFakeClient } from "./test/fakes.ts";
import { DUB_OPERATE_CWD, OPERATE_RUN_ARGS } from "./lib/operateDub.ts";
import type { DaemonRunEvent } from "./lib/client.ts";

// A planner answer with three ops: a read, a plain write, and a DELETE the planner
// (wrongly) marked non-destructive — the UI's safety net must treat it as destructive.
const planJson = {
  summary: "テスト計画",
  ops: [
    { id: "r1", kind: "d1_read", title: "件数を数える", sql: "SELECT count(*) FROM users", destructive: false },
    { id: "w1", kind: "d1_write", title: "サンプル投入", sql: "INSERT INTO users(id) VALUES('a')", destructive: false },
    { id: "x1", kind: "d1_write", title: "全削除", sql: "DELETE FROM users", destructive: false },
  ],
};
const events: DaemonRunEvent[] = [
  { type: "status", status: "running" },
  { type: "claude", data: { type: "result", subtype: "success", result: "```json\n" + JSON.stringify(planJson) + "\n```" } },
  { type: "status", status: "succeeded" },
];

async function makePlan() {
  const client = makeFakeClient(events);
  render(<OperateDub client={client} />);
  fireEvent.change(screen.getByTestId("operate-input"), { target: { value: "サンプルを入れて" } });
  fireEvent.click(screen.getByTestId("operate-plan-btn"));
  await screen.findByTestId("operate-plan");
  const cards = screen.getAllByTestId("operate-op");
  expect(cards).toHaveLength(3);
  return { client, cards };
}

describe("<OperateDub> safety gate", () => {
  it("plans in the dub-ecosystem repo with subagent fan-out disabled", async () => {
    const { client } = await makePlan();
    expect(client.startRun).toHaveBeenCalledWith(
      expect.stringContaining("要望: サンプルを入れて"),
      { cwd: DUB_OPERATE_CWD, args: OPERATE_RUN_ARGS },
    );
  });

  it("runs a READ op immediately (no confirm gate)", async () => {
    const { client, cards } = await makePlan();
    const read = cards.find((c) => c.getAttribute("data-op-kind") === "d1_read")!;
    const callsBefore = client.startRun.mock.calls.length; // 1 (the plan)
    fireEvent.click(within(read).getByTestId("operate-op-run"));
    await waitFor(() => expect(client.startRun.mock.calls.length).toBe(callsBefore + 1));
  });

  it("gates a WRITE op behind an explicit confirm", async () => {
    const { client, cards } = await makePlan();
    // The plain INSERT: write, not destructive.
    const write = cards.find(
      (c) => c.getAttribute("data-op-kind") === "d1_write" && c.getAttribute("data-op-destructive") === "0",
    )!;
    const callsBefore = client.startRun.mock.calls.length;

    // First click only opens the confirm panel — it must NOT execute.
    fireEvent.click(within(write).getByTestId("operate-op-run"));
    expect(within(write).getByTestId("operate-op-confirm-panel")).toBeInTheDocument();
    expect(client.startRun.mock.calls.length).toBe(callsBefore);

    // Confirming executes.
    fireEvent.click(within(write).getByTestId("operate-op-confirm"));
    await waitFor(() => expect(client.startRun.mock.calls.length).toBe(callsBefore + 1));
  });

  it("requires a typed confirmation for a DESTRUCTIVE op (safety net catches mislabeled DELETE)", async () => {
    const { client, cards } = await makePlan();
    const del = cards.find((c) => c.getAttribute("data-op-destructive") === "1")!;
    // The planner said destructive:false; the safety net promoted the DELETE.
    expect(del).toBeTruthy();
    const callsBefore = client.startRun.mock.calls.length;

    fireEvent.click(within(del).getByTestId("operate-op-run"));
    const confirmBtn = within(del).getByTestId("operate-op-confirm") as HTMLButtonElement;
    // Disabled until the confirm phrase is typed.
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.click(confirmBtn);
    expect(client.startRun.mock.calls.length).toBe(callsBefore); // still gated

    fireEvent.change(within(del).getByTestId("operate-op-confirm-input"), { target: { value: "実行" } });
    expect((within(del).getByTestId("operate-op-confirm") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(del).getByTestId("operate-op-confirm"));
    await waitFor(() => expect(client.startRun.mock.calls.length).toBe(callsBefore + 1));
  });
});
