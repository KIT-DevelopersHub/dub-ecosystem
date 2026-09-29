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

  it("composer creates a task then starts a run with its taskId + cwd", async () => {
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
    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt, opts] = client.startRun.mock.calls[0]!;
    expect(prompt).toBe("作って");
    expect(opts).toMatchObject({ cwd: "/repo/login" });
    expect(opts.taskId).toMatch(/^task-/);
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

  it("staging approval kicks a REAL staging反映 run instead of flipping straight to staging_review", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "rev", featureId: "feat-1", title: "反映対象", featurePhase: "demo_review", runStatus: "succeeded" }),
    ]);
    const client = makeFakeClient();
    render(<Board client={client} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-approve"));
    await userEvent.click(await screen.findByTestId("approval-confirm-yes"));

    // A real run is kicked (the "反映中" work), carrying the staging反映 instruction + cwd.
    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt, opts] = client.startRun.mock.calls.at(-1)!;
    expect(prompt).toMatch(/staging に反映/);
    expect(opts).toMatchObject({ taskId: "rev", cwd: "/repo/wt" });
    // It must NOT auto-advance to staging_review here — the run's success does that.
    expect(api.transition).not.toHaveBeenCalledWith("feat-1", "staging_review", expect.anything());
  });

  it("shows a visible 反映中 in-flight banner while a staging approval is processing", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "rev", featureId: "feat-1", title: "反映対象", featurePhase: "demo_review", runStatus: "succeeded" }),
    ]);
    // Hold the run kick open so the in-flight state is observable.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = makeFakeClient();
    client.startRun.mockImplementation(async () => {
      await gate;
      return { runId: "run-new" };
    });
    render(<Board client={client} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-approve"));
    await userEvent.click(await screen.findByTestId("approval-confirm-yes"));

    const banner = await screen.findByTestId("action-inflight");
    expect(banner).toHaveTextContent("staging に反映中");
    release();
    await waitFor(() => expect(screen.queryByTestId("action-inflight")).not.toBeInTheDocument());
  });

  it("prod approval kicks a REAL 本番反映 run and ships via the approval gate (approvedByUser:true)", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "rev", featureId: "feat-1", title: "本番反映対象", featurePhase: "staging_review", runStatus: "succeeded" }),
    ]);
    const client = makeFakeClient();
    render(<Board client={client} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-approve"));
    await userEvent.click(await screen.findByTestId("approval-confirm-yes"));

    // A real run is kicked (本番反映中 の実作業), carrying the本番反映 instruction + cwd.
    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt, opts] = client.startRun.mock.calls.at(-1)!;
    expect(prompt).toMatch(/本番に反映/);
    expect(opts).toMatchObject({ taskId: "rev", cwd: "/repo/wt" });
    // And the ship transition goes through the approval gate.
    await waitFor(() =>
      expect(api.transition).toHaveBeenCalledWith("feat-1", "prod_shipped", { approvedByUser: true }),
    );
  });

  it("shows a本番反映中 in-flight banner while a prod approval is processing", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "rev", featureId: "feat-1", title: "本番反映対象", featurePhase: "staging_review", runStatus: "succeeded" }),
    ]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = makeFakeClient();
    client.startRun.mockImplementation(async () => {
      await gate;
      return { runId: "run-new" };
    });
    render(<Board client={client} api={api} pollMs={0} />);

    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-approve"));
    await userEvent.click(await screen.findByTestId("approval-confirm-yes"));

    const banner = await screen.findByTestId("action-inflight");
    expect(banner).toHaveTextContent("本番に反映中");
    release();
    await waitFor(() => expect(screen.queryByTestId("action-inflight")).not.toBeInTheDocument());
  });

  it("a本番反映 run in flight keeps the card in 走行中 as 「本番反映中」 (not jumping straight to 完了)", async () => {
    const api = makeFakeApi([
      makeBoardItem({ taskId: "prd", featureId: "feat-1", title: "本番反映中カード", featurePhase: "prod_shipped", runStatus: "running" }),
    ]);
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);
    expect(await within(screen.getByTestId("lane-running")).findByText("本番反映中カード")).toBeInTheDocument();
    expect(screen.getByTestId("task-deploying-prd")).toHaveTextContent("本番反映中");
  });

  it("shows a 反映済み badge on a 確認待ち card so staging反映の完了が一目で分かる", async () => {
    const api = makeFakeApi([
      makeBoardItem({
        taskId: "rev",
        featureId: "feat-1",
        title: "反映済み確認カード",
        featurePhase: "staging_review",
        runStatus: "succeeded",
        stagingUrl: "https://stg.example",
      }),
    ]);
    render(<Board client={makeFakeClient()} api={api} pollMs={0} />);
    const badge = await screen.findByTestId("reflection-badge-rev");
    expect(badge).toHaveAttribute("data-reflection-state", "reflected");
    expect(badge).toHaveTextContent("stagingに反映済み");
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
