import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { OperateDub } from "./OperateDub.tsx";
import { ChatProvider } from "./lib/chatStore.tsx";
import { makeFakeApi, makeFakeClient, type FakeApi } from "./test/fakes.ts";
import { makeFakeOperateClient } from "./test/operateFakes.ts";
import { OPERATE_PLANNER_ARGS, OPERATE_PLANNER_CWD } from "./lib/operateDub.ts";
import { OperateError, type ExecutionResult, type Preview } from "./lib/operateApi.ts";
import type { CommanderClient, DaemonRunEvent } from "./lib/client.ts";

const reply = (result: string): DaemonRunEvent[] => [
  { type: "status", status: "running" },
  { type: "claude", data: { type: "result", subtype: "success", result } },
  { type: "status", status: "succeeded" },
];

const planText = (summary: string) =>
  "計画です。\n```json\n" + JSON.stringify({ type: "plan", summary, steps: [{ id: "list", op: "events.list" }] }) + "\n```";

const EVENT_PREVIEW: Preview = {
  previewId: "pv1",
  summary: "概要を差し替え",
  environment: "staging",
  reads: [{ stepId: "list", entryId: "events.list", description: "イベントの一覧を取得する", ok: true, count: 2, sample: '{"items":[]}' }],
  writes: [
    {
      stepId: "upd",
      entryId: "events.update",
      kind: "write",
      risk: "mid",
      reversible: true,
      description: "イベントのタイトル・概要・日時を更新する",
      impact: "1件のイベントの表示内容が書き換わります。",
      fieldLabels: { description: "概要" },
      calls: [
        { callId: "upd#1", method: "PATCH", path: "/events/ev1", params: { id: "ev1" }, body: { description: "新しい概要", version: 3 }, target: "北陸ITカンファレンス2027", before: { description: "旧概要" } },
      ],
    },
  ],
  blockers: [],
  expiresAt: "2026-10-10T01:00:00.000Z",
};

const NOTIF_PREVIEW: Preview = {
  ...EVENT_PREVIEW,
  previewId: "pv2",
  writes: [
    {
      stepId: "del",
      entryId: "notifications.unpublish",
      kind: "delete",
      risk: "high",
      reversible: true,
      description: "通知を削除する",
      impact: "通知がメンバー全員の受信箱から消えます。",
      calls: [1, 2, 3, 4].map((i) => ({ callId: `del#${i}`, method: "POST", path: `/notifications/manage/n${i}/unpublish`, params: { id: `n${i}` }, target: `通知${i}` })),
    },
  ],
};

const DONE: ExecutionResult = {
  previewId: "pv1",
  verdict: "done",
  headline: "反映できました（1件すべて読み直して確認済み）",
  results: [{ callId: "upd#1", stepId: "upd", target: "北陸ITカンファレンス2027", outcome: "ok", message: "反映を確認しました" }],
  executedAt: "2026-10-10T00:10:00.000Z",
};

/** A client whose N-th run streams the N-th reply. */
function sequencedClient(results: string[]): CommanderClient & { startRun: ReturnType<typeof vi.fn> } {
  const base = makeFakeClient();
  let n = 0;
  return {
    ...base,
    streamEvents: (_id, onEvent, onClose) => {
      for (const ev of reply(results[Math.min(n, results.length - 1)]!)) onEvent(ev);
      n++;
      onClose();
      return () => {};
    },
  };
}

function setup(opts: { results?: string[]; preview?: Preview; execute?: ExecutionResult; previewError?: Error } = {}) {
  const client = sequencedClient(opts.results ?? [planText("概要を差し替えます")]);
  const operateClient = makeFakeOperateClient({ preview: opts.preview ?? EVENT_PREVIEW, execute: opts.execute ?? DONE, previewError: opts.previewError });
  const api: FakeApi = makeFakeApi();
  render(
    <ChatProvider api={api} client={client}>
      <OperateDub operateClient={operateClient} />
    </ChatProvider>,
  );
  return { client, operateClient, api };
}

async function send(text: string) {
  await waitFor(() => expect(screen.getByTestId("chat-input")).not.toBeDisabled());
  fireEvent.change(screen.getByTestId("chat-input"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("chat-send"));
}

const conclusion = () => screen.getByTestId("operate-conclusion").textContent;
const persisted = (api: FakeApi, prefix: string) => api._messages.filter((m) => m.text.startsWith(prefix)).map((m) => m.text);

describe("<OperateDub> planner", () => {
  beforeEach(() => localStorage.clear());

  it("plans with no tools, outside the repo, with the whole session", async () => {
    const { client } = setup({ results: ["こんにちは。イベント編集などができます。"] });
    await send("何ができるの？");
    await screen.findByText(/イベント編集などができます/);
    await send("通知を消して");
    await waitFor(() => expect(client.startRun).toHaveBeenCalledTimes(2));
    expect(client.startRun).toHaveBeenLastCalledWith(expect.stringContaining("# 今回の依頼\n通知を消して"), {
      cwd: OPERATE_PLANNER_CWD,
      args: OPERATE_PLANNER_ARGS,
    });
    const prompt = client.startRun.mock.calls[1]![0] as string;
    expect(prompt).toContain("[ユーザー]\n何ができるの？");
    expect(prompt).toContain("- events.update [書き込み");
    expect(screen.queryByTestId("operate-approval")).toBeNull();
  });

  it("answers a read-only plan in prose from the read results", async () => {
    const readOnly: Preview = { ...EVENT_PREVIEW, writes: [] };
    const { client, api } = setup({ results: [planText("イベントを数えます"), "イベントは2件です。"], preview: readOnly });
    await send("イベントは何件？");
    await screen.findByText("イベントは2件です。");
    expect(client.startRun).toHaveBeenCalledTimes(2);
    expect(client.startRun.mock.calls[1]![0]).toContain("[システム]\n【確認結果】読み取り1件を実行");
    expect(persisted(api, "【確認結果】")).toHaveLength(1);
    expect(screen.getAllByTestId("operate-conclusion").map((c) => c.textContent)).toContain("結論: 読み取りだけを行いました。データは変更していません");
  });
});

describe("<OperateDub> approval screen", () => {
  beforeEach(() => localStorage.clear());

  it("leads with 何を・何件・誰に, shows before/after, effect, undo and risk, and folds API details", async () => {
    setup();
    await send("北陸の概要を差し替えて");
    const card = await screen.findByTestId("operate-approval");
    const head = within(card).getByTestId("operate-headline").textContent!;
    expect(head).toContain("何をイベントのタイトル・概要・日時を更新する");
    expect(head).toContain("何件1件");
    expect(head).toContain("誰に北陸ITカンファレンス2027");
    expect(within(card).getByTestId("operate-change").textContent).toBe("概要: 旧概要 → 新しい概要");
    expect(within(card).getByTestId("operate-impact").textContent).toContain("書き換わります");
    expect(within(card).getByTestId("operate-reversible").textContent).toBe("できる");
    expect(within(card).getByTestId("operate-risk").textContent).toBe("中");
    expect(within(card).getByTestId("operate-env").textContent).toBe("接続先: staging");
    expect((within(card).getByTestId("operate-details") as HTMLDetailsElement).open).toBe(false);
    expect(card.textContent).not.toMatch(/\{"|"\}/);
    expect(conclusion()).toMatch(/^結論: まだ何も変更していません/);
  });

  it("executes the approved preview once and ends with the verdict", async () => {
    const { operateClient, api } = setup();
    await send("北陸の概要を差し替えて");
    fireEvent.click(await screen.findByTestId("operate-execute"));
    await screen.findByTestId("operate-results");
    expect(operateClient.execute).toHaveBeenCalledWith("pv1", []);
    expect(conclusion()).toBe("結論: 反映できました（1件すべて読み直して確認済み）");
    await waitFor(() => expect(persisted(api, "【実行結果】")).toEqual(["【実行結果】反映できました（1件すべて読み直して確認済み）\n- 北陸ITカンファレンス2027: 反映済み（反映を確認しました）"]));
    expect(screen.queryByTestId("operate-execute")).toBeNull();
    // The persisted 【実行結果】 renders as a quiet note, not a second chat bubble.
    await waitFor(() => expect(screen.getAllByTestId("operate-note").some((n) => n.textContent!.startsWith("【実行結果】"))).toBe(true));
  });

  it("requires the typed phrase for high-risk work and lets the operator drop targets", async () => {
    const { operateClient } = setup({ preview: NOTIF_PREVIEW });
    await send("通知を削除して");
    const card = await screen.findByTestId("operate-approval");
    expect(within(card).getAllByTestId("operate-target")).toHaveLength(3);
    fireEvent.click(within(card).getByTestId("operate-expand"));
    expect(within(card).getAllByTestId("operate-target")).toHaveLength(4);

    fireEvent.click(within(card).getByTestId("operate-narrow"));
    fireEvent.click(within(card).getAllByTestId("operate-target-check")[1]!);
    expect(within(card).getByTestId("operate-count").textContent).toBe("3件");

    const run = within(card).getByTestId("operate-execute") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(within(card).getByTestId("operate-confirm-input"), { target: { value: "実行" } });
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() => expect(operateClient.execute).toHaveBeenCalledWith("pv2", ["del#2"]));
  });

  it("やめる changes nothing and says so", async () => {
    const { operateClient, api } = setup();
    await send("北陸の概要を差し替えて");
    fireEvent.click(await screen.findByTestId("operate-cancel"));
    expect(conclusion()).toBe("結論: 実行をやめました。何も変更していません");
    expect(operateClient.execute).not.toHaveBeenCalled();
    await waitFor(() => expect(persisted(api, "【実行結果】")).toEqual(["【実行結果】実行をやめました。何も変更していません"]));
  });

  it("refuses a blocked plan with the reasons in Japanese", async () => {
    setup({ preview: { ...EVENT_PREVIEW, blockers: ["手順3: params.id が決まっていません（読み取り結果から埋められませんでした）"] } });
    await send("北陸の概要を差し替えて");
    const card = await screen.findByTestId("operate-approval");
    expect(within(card).getByTestId("operate-blockers").textContent).toContain("params.id が決まっていません");
    expect(within(card).queryByTestId("operate-execute")).toBeNull();
    expect(conclusion()).toBe("結論: この計画は実行できません。何も変更していません");
  });

  it("explains an invalid plan from the daemon without executing anything", async () => {
    const { api } = setup({ previewError: new OperateError("計画に問題があります", ["手順1: 「d1.execute」は許可された操作にありません"]) });
    await send("SQL で消して");
    const err = await screen.findByTestId("operate-approval-error");
    expect(err.textContent).toContain("許可された操作にありません");
    expect(conclusion()).toBe("結論: 実行できません。何も変更していません");
    await waitFor(() => expect(persisted(api, "【確認結果】")[0]).toMatch(/実行できません/));
  });

  it("shows a skeleton while the catalog loads", () => {
    const client = makeFakeClient();
    const operateClient = { ...makeFakeOperateClient(), catalog: vi.fn(() => new Promise<never>(() => {})) };
    render(
      <ChatProvider api={makeFakeApi()} client={client}>
        <OperateDub operateClient={operateClient} />
      </ChatProvider>,
    );
    expect(screen.getByTestId("operate-loading")).toBeInTheDocument();
  });
});
