import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { OperateDub } from "./OperateDub.tsx";
import { ChatProvider } from "./lib/chatStore.tsx";
import { makeFakeApi, makeFakeClient, type FakeApi } from "./test/fakes.ts";
import { DUB_OPERATE_CWD, OPERATE_RUN_ARGS } from "./lib/operateDub.ts";
import type { CommanderClient, DaemonRunEvent } from "./lib/client.ts";

// The planner returns three ops: a read, a plain write, and a DELETE the planner (wrongly)
// marked non-destructive — the UI's safety net must treat it as destructive.
const planJson = {
  summary: "テスト計画",
  ops: [
    { id: "r1", kind: "d1_read", title: "件数を数える", sql: "SELECT count(*) FROM users", destructive: false },
    { id: "w1", kind: "d1_write", title: "サンプル投入", sql: "INSERT INTO users(id) VALUES('a')", destructive: false },
    { id: "x1", kind: "d1_write", title: "全削除", sql: "DELETE FROM users", destructive: false },
  ],
};
const planFlow: DaemonRunEvent[] = [
  { type: "status", status: "running" },
  { type: "claude", data: { type: "result", subtype: "success", result: "```json\n" + JSON.stringify(planJson) + "\n```" } },
  { type: "status", status: "succeeded" },
];

function renderOperate(api: FakeApi, client: CommanderClient) {
  return render(
    <ChatProvider api={api} client={client}>
      <OperateDub />
    </ChatProvider>,
  );
}

async function plan(client: CommanderClient) {
  const api = makeFakeApi();
  renderOperate(api, client);
  fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "サンプルを入れて" } });
  fireEvent.click(screen.getByTestId("chat-send"));
  await screen.findByTestId("operate-plan");
  const cards = screen.getAllByTestId("operate-op");
  expect(cards).toHaveLength(3);
  return { api, cards };
}

describe("<OperateDub> safety gate (multi-session, persisted)", () => {
  beforeEach(() => localStorage.clear());

  it("plans in dub-ecosystem with subagent fan-out disabled", async () => {
    const client = makeFakeClient(planFlow);
    await plan(client);
    expect(client.startRun).toHaveBeenCalledWith(
      expect.stringContaining("要望: サンプルを入れて"),
      { cwd: DUB_OPERATE_CWD, args: OPERATE_RUN_ARGS },
    );
  });

  it("runs a READ op immediately (no confirm gate)", async () => {
    const client = makeFakeClient(planFlow);
    const { cards } = await plan(client);
    const read = cards.find((c) => c.getAttribute("data-op-kind") === "d1_read")!;
    const before = (client.startRun as ReturnType<typeof makeFakeClient>["startRun"]).mock.calls.length;
    fireEvent.click(within(read).getByTestId("operate-op-run"));
    await waitFor(() =>
      expect((client.startRun as ReturnType<typeof makeFakeClient>["startRun"]).mock.calls.length).toBe(before + 1),
    );
  });

  it("gates a WRITE op behind an explicit confirm", async () => {
    const client = makeFakeClient(planFlow);
    const { cards } = await plan(client);
    const write = cards.find(
      (c) => c.getAttribute("data-op-kind") === "d1_write" && c.getAttribute("data-op-destructive") === "0",
    )!;
    const fn = client.startRun as ReturnType<typeof makeFakeClient>["startRun"];
    const before = fn.mock.calls.length;

    fireEvent.click(within(write).getByTestId("operate-op-run"));
    expect(within(write).getByTestId("operate-op-confirm-panel")).toBeInTheDocument();
    expect(fn.mock.calls.length).toBe(before); // not yet executed

    fireEvent.click(within(write).getByTestId("operate-op-confirm"));
    await waitFor(() => expect(fn.mock.calls.length).toBe(before + 1));
  });

  it("requires a typed confirmation for a DESTRUCTIVE op (safety net catches mislabeled DELETE)", async () => {
    const client = makeFakeClient(planFlow);
    const { cards } = await plan(client);
    const del = cards.find((c) => c.getAttribute("data-op-destructive") === "1")!;
    expect(del).toBeTruthy();
    const fn = client.startRun as ReturnType<typeof makeFakeClient>["startRun"];
    const before = fn.mock.calls.length;

    fireEvent.click(within(del).getByTestId("operate-op-run"));
    const confirmBtn = within(del).getByTestId("operate-op-confirm") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.click(confirmBtn);
    expect(fn.mock.calls.length).toBe(before); // still gated

    fireEvent.change(within(del).getByTestId("operate-op-confirm-input"), { target: { value: "実行" } });
    expect((within(del).getByTestId("operate-op-confirm") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(del).getByTestId("operate-op-confirm"));
    await waitFor(() => expect(fn.mock.calls.length).toBe(before + 1));
  });
});
