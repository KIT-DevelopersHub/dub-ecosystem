import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OperateDub } from "./OperateDub.tsx";
import { ChatProvider } from "./lib/chatStore.tsx";
import { makeFakeApi, makeFakeClient } from "./test/fakes.ts";
import { makeFakeOperateClient } from "./test/operateFakes.ts";
import { OPERATE_PLANNER_ARGS, OPERATE_PLANNER_CWD } from "./lib/operateDub.ts";
import type { DaemonRunEvent } from "./lib/client.ts";

const reply = (result: string): DaemonRunEvent[] => [
  { type: "status", status: "running" },
  { type: "claude", data: { type: "result", subtype: "success", result } },
  { type: "status", status: "succeeded" },
];

const PLAN_TEXT =
  "概要を差し替えます。\n```json\n" +
  JSON.stringify({
    type: "plan",
    summary: "イベント1件の概要を差し替えます",
    steps: [
      { id: "list", op: "events.list" },
      { id: "upd", op: "events.update", forEach: "list.items", params: { id: "{{item.id}}" }, body: { description: "新", version: "{{item.version}}" } },
    ],
  }) +
  "\n```";

function setup(result: string) {
  const client = makeFakeClient(reply(result));
  const operateClient = makeFakeOperateClient();
  render(
    <ChatProvider api={makeFakeApi()} client={client}>
      <OperateDub operateClient={operateClient} />
    </ChatProvider>,
  );
  return { client, operateClient };
}

async function send(text: string) {
  await waitFor(() => expect(screen.getByTestId("chat-input")).not.toBeDisabled());
  fireEvent.change(screen.getByTestId("chat-input"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("chat-send"));
}

describe("<OperateDub> planner", () => {
  beforeEach(() => localStorage.clear());

  it("plans with no tools, outside the repo, from the catalog", async () => {
    const { client } = setup(PLAN_TEXT);
    await send("北陸の概要を差し替えて");
    await screen.findByTestId("operate-plan");
    expect(client.startRun).toHaveBeenCalledWith(expect.stringContaining("# 今回の依頼\n北陸の概要を差し替えて"), {
      cwd: OPERATE_PLANNER_CWD,
      args: OPERATE_PLANNER_ARGS,
    });
    expect(client.startRun.mock.calls[0]![0]).toContain("- events.update [書き込み");
  });

  it("renders a plan in Japanese without raw JSON", async () => {
    setup(PLAN_TEXT);
    await send("北陸の概要を差し替えて");
    const plan = await screen.findByTestId("operate-plan");
    expect(plan.textContent).toContain("イベント1件の概要を差し替えます");
    expect(screen.getAllByTestId("operate-plan-step").map((s) => s.textContent)).toEqual([
      "イベントの一覧を取得する",
      "イベントのタイトル・概要・日時を更新する",
    ]);
    expect(plan.textContent).not.toMatch(/[{}]|"steps"/);
  });

  it("answers small talk as plain text and remembers it next turn", async () => {
    const { client } = setup("こんにちは。イベント編集・メール発行・通知の操作ができます。");
    await send("何ができるの？");
    await screen.findByText(/イベント編集・メール発行・通知の操作ができます/);
    expect(screen.queryByTestId("operate-plan")).toBeNull();

    await send("じゃあ通知を消して");
    await waitFor(() => expect(client.startRun).toHaveBeenCalledTimes(2));
    const second = client.startRun.mock.calls[1]![0] as string;
    expect(second).toContain("[ユーザー]\n何ができるの？");
    expect(second).toContain("[アシスタント]\nこんにちは。");
  });
});
