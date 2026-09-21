import { describe, it, expect } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board } from "./Board.tsx";
import { makeBoardItem, makeFakeApi, makeFakeClient } from "./test/fakes.ts";

describe("<Board>", () => {
  it("renders all five lanes and an empty state when there are no tasks", async () => {
    render(<Board client={makeFakeClient()} api={makeFakeApi([])} pollMs={0} />);
    for (const lane of ["queued", "running", "review", "needs_fix", "done"]) {
      expect(screen.getByTestId(`lane-${lane}`)).toBeInTheDocument();
    }
    expect(await screen.findByTestId("board-empty")).toBeInTheDocument();
  });

  it("buckets tasks into the correct lanes", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "run-t", title: "走行カード", runStatus: "running" }),
      makeBoardItem({ taskId: "rev-t", featureId: "feat-rev", title: "確認カード", featurePhase: "demo_review", runStatus: "succeeded" }),
      makeBoardItem({ taskId: "fix-t", featureId: "feat-fix", title: "修正カード", featurePhase: "demo_rejected", runStatus: "failed" }),
      makeBoardItem({ taskId: "done-t", featureId: "feat-done", title: "完了カード", featurePhase: "prod_shipped", runStatus: "succeeded" }),
    ]);
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);
    expect(await within(screen.getByTestId("lane-running")).findByText("走行カード")).toBeInTheDocument();
    expect(within(screen.getByTestId("lane-review")).getByText("確認カード")).toBeInTheDocument();
    expect(within(screen.getByTestId("lane-needs_fix")).getByText("修正カード")).toBeInTheDocument();
    expect(within(screen.getByTestId("lane-done")).getByText("完了カード")).toBeInTheDocument();
  });

  it("composer registers a task WITHOUT running it (propose-first)", async () => {
    const api = makeFakeApi([]);
    const client = makeFakeClient();
    render(<Board client={client} api={api} pollMs={0} />);
    await screen.findByTestId("board-empty");

    await userEvent.click(screen.getByTestId("open-composer"));
    await userEvent.type(screen.getByLabelText("task-title"), "ログイン画面を作る");
    await userEvent.clear(screen.getByLabelText("task-cwd"));
    await userEvent.type(screen.getByLabelText("task-cwd"), "/repo/login");
    await userEvent.type(screen.getByLabelText("task-prompt"), "作って");
    await userEvent.click(screen.getByTestId("composer-submit"));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ title: "ログイン画面を作る", ledgerRef: undefined }));
    // The task lands in 投入待ち — no run started until 「AIに依頼する」 is pressed.
    expect(await within(screen.getByTestId("lane-queued")).findByText("ログイン画面を作る")).toBeInTheDocument();
    expect(client.startRun).not.toHaveBeenCalled();

    // Now request the run from the card button → it starts with the captured prompt/cwd.
    await userEvent.click(within(screen.getByTestId("lane-queued")).getByTestId(/^task-request-run-/));
    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt, opts] = client.startRun.mock.calls[0]!;
    expect(prompt).toBe("作って");
    expect(opts).toMatchObject({ cwd: "/repo/login" });
    expect(opts.taskId).toMatch(/^task-/);
  });

  it("chat: a work request is registered as 未依頼 and runs only after 「AIに依頼する」", async () => {
    const api = makeFakeApi([]);
    const client = makeFakeClient();
    render(<Board client={client} api={api} pollMs={0} />);
    await screen.findByTestId("board-empty");

    await userEvent.type(screen.getByTestId("chat-input"), "俺の自己紹介ページを作って");
    await userEvent.click(screen.getByTestId("chat-send"));

    // Task registered, assistant asks — but NO run yet.
    await waitFor(() => expect(api.createTask).toHaveBeenCalled());
    expect(client.startRun).not.toHaveBeenCalled();
    const runBtn = await screen.findByTestId(/^chat-request-run-/);

    await userEvent.click(runBtn);
    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt] = client.startRun.mock.calls[0]!;
    expect(prompt).toBe("俺の自己紹介ページを作って");
  });

  it("chat: pure chit-chat neither registers a task nor runs anything", async () => {
    const api = makeFakeApi([]);
    const client = makeFakeClient();
    render(<Board client={client} api={api} pollMs={0} />);
    await screen.findByTestId("board-empty");

    await userEvent.type(screen.getByTestId("chat-input"), "ありがとう！");
    await userEvent.click(screen.getByTestId("chat-send"));

    expect(await screen.findByTestId("chat-msg-assistant")).toBeInTheDocument();
    expect(api.createTask).not.toHaveBeenCalled();
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it("auto-advances a succeeded build to demo_review (deploy-complete marker)", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "t", featureId: "feat-1", title: "自動昇格", featurePhase: "demo_building", runStatus: "succeeded" }),
    ]);
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);
    await waitFor(() =>
      expect(api.transition).toHaveBeenCalledWith("feat-1", "demo_review", { approvedByUser: false }),
    );
  });

  it("approve on a review task goes through the approval gate (approvedByUser:true)", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "rev", featureId: "feat-1", title: "承認対象", featurePhase: "demo_review", runStatus: "succeeded" }),
    ]);
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-approve"));
    await userEvent.click(await screen.findByTestId("approval-confirm-yes"));

    await waitFor(() =>
      expect(api.transition).toHaveBeenCalledWith("feat-1", "staging_deployed", { approvedByUser: true }),
    );
  });

  it("reject carries feedback into a new run and sends the feature back to building", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "rev", featureId: "feat-1", title: "却下対象", featurePhase: "demo_review", runStatus: "succeeded" }),
    ]);
    const client = makeFakeClient();
    render(<Board client={client} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-reject"));
    await userEvent.type(screen.getByLabelText("reject-feedback"), "余白が足りない");
    await userEvent.click(screen.getByTestId("reject-submit"));

    await waitFor(() =>
      expect(api.transition).toHaveBeenCalledWith("feat-1", "demo_rejected", { approvedByUser: false, note: "余白が足りない" }),
    );
    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt] = client.startRun.mock.calls.at(-1)!;
    expect(prompt).toContain("余白が足りない");
    expect(prompt).toContain("元の指示"); // prior context re-injected
  });

  it("追加指示 starts a follow-up run with the prior context re-injected", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "rev", featureId: "feat-1", title: "追加指示対象", featurePhase: "demo_review", runStatus: "succeeded" }),
    ]);
    const client = makeFakeClient();
    render(<Board client={client} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-rerun"));
    await userEvent.type(screen.getByLabelText("rerun-prompt"), "ボタンを大きく");
    await userEvent.click(screen.getByTestId("rerun-submit"));

    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt, opts] = client.startRun.mock.calls.at(-1)!;
    expect(prompt).toContain("ボタンを大きく");
    expect(prompt).toContain("元の指示");
    expect(opts.taskId).toBe("rev");
  });

  it("完了 archives the task (updateTaskStatus done)", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "rev", featureId: "feat-1", title: "アーカイブ対象", featurePhase: "demo_review", runStatus: "succeeded" }),
    ]);
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-archive"));
    await waitFor(() => expect(api.updateTaskStatus).toHaveBeenCalledWith("rev", "done"));
  });

  it("shows a daemon-down hint when the exec bridge is unreachable", async () => {
    const client = makeFakeClient();
    client.health = (async () => false) as typeof client.health;
    render(<Board client={client} api={makeFakeApi([])} pollMs={0} />);
    expect(await screen.findByTestId("daemon-down-hint")).toBeInTheDocument();
  });
});
