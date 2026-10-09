import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { OperateDub } from "./OperateDub.tsx";
import { ChatProvider } from "./lib/chatStore.tsx";
import { makeFakeApi, makeFakeClient, type FakeApi } from "./test/fakes.ts";
import { DUB_OPERATE_CWD, OPERATE_RUN_ARGS } from "./lib/operateDub.ts";
import type { CommanderClient, DaemonRunEvent } from "./lib/client.ts";

// The planner returns three ops: a read, a plain write, and a DELETE the planner (wrongly)
// marked non-destructive — still flagged destructive, and none of them is executable.
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

describe("<OperateDub> planner (multi-session, persisted)", () => {
  beforeEach(() => localStorage.clear());

  it("plans in dub-ecosystem with subagent fan-out disabled", async () => {
    const client = makeFakeClient(planFlow);
    await plan(client);
    expect(client.startRun).toHaveBeenCalledWith(
      expect.stringContaining("要望: サンプルを入れて"),
      { cwd: DUB_OPERATE_CWD, args: OPERATE_RUN_ARGS },
    );
  });

  it("renders plan ops without any way to execute them", async () => {
    const client = makeFakeClient(planFlow);
    const { cards } = await plan(client);
    const fn = client.startRun as ReturnType<typeof makeFakeClient>["startRun"];
    expect(fn).toHaveBeenCalledTimes(1); // the planner only
    for (const card of cards) {
      expect(within(card).queryByRole("button")).toBeNull();
      expect(card.textContent).not.toMatch(/wrangler|curl/);
    }
    expect(cards.find((c) => c.getAttribute("data-op-destructive") === "1")).toBeTruthy();
  });
});
