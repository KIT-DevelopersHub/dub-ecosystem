import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.tsx";
import type { CommanderClient, DaemonRunEvent } from "./lib/client.ts";
import type { CommanderApi } from "./lib/commanderApi.ts";

function fakeClient(events: DaemonRunEvent[]): CommanderClient {
  return {
    startRun: vi.fn(async () => ({ runId: "run-1" })),
    cancelRun: vi.fn(async () => {}),
    streamEvents: (_runId, onEvent, onClose) => {
      for (const ev of events) onEvent(ev);
      onClose();
      return () => {};
    },
  };
}

// Empty phase-gate API stub so mounting <FeatureBoard> inside <App> never hits the
// network in these run-console tests.
const emptyApi: CommanderApi = {
  listFeatures: async () => [],
  createFeature: async () => ({ ok: false, error: { status: 0, error: "stub" } }),
  getFeature: async () => {
    throw new Error("not used");
  },
  transition: async () => ({ ok: false, error: { status: 0, error: "stub" } }),
  listRuns: async () => [],
  getRun: async () => null,
};

describe("<App>", () => {
  it("renders the prompt console idle", async () => {
    render(<App client={fakeClient([])} api={emptyApi} />);
    expect(screen.getByLabelText("prompt")).toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent("status: idle");
    // let the embedded FeatureBoard's initial load settle (avoids act() warning)
    await screen.findByTestId("feature-list");
  });

  it("streams run events into the log and reaches succeeded", async () => {
    const client = fakeClient([
      { type: "status", status: "running" },
      { type: "claude", data: { type: "result", result: "PONG" } },
      { type: "exit", code: 0 },
      { type: "status", status: "succeeded" },
    ]);
    render(<App client={client} api={emptyApi} />);

    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("succeeded");
    });
    expect(screen.getByTestId("log")).toHaveTextContent("claude> PONG");
    expect(client.startRun).toHaveBeenCalledOnce();
  });

  it("restores a persisted run's status + log from history after a reset", async () => {
    // Simulates a fresh page/process after a reset: no live run, but the phase-gate
    // service (D1 on disk) still has a past run. The console must show it and restore it.
    const historyApi: CommanderApi = {
      ...emptyApi,
      listRuns: async () => [
        {
          id: "run-42",
          taskId: null,
          prompt: "build the login page",
          cwd: "/repo",
          status: "succeeded",
          exitCode: 0,
          createdAt: "2026-09-18T00:00:00.000Z",
          updatedAt: "2026-09-18T00:01:00.000Z",
        },
      ],
      getRun: async () => ({
        run: {
          id: "run-42",
          taskId: null,
          prompt: "build the login page",
          cwd: "/repo",
          status: "succeeded",
          exitCode: 0,
          createdAt: "2026-09-18T00:00:00.000Z",
          updatedAt: "2026-09-18T00:01:00.000Z",
        },
        events: [
          { id: "e1", runId: "run-42", type: "claude", payload: { data: { result: "DONE" } }, createdAt: "t" },
          { id: "e2", runId: "run-42", type: "status", payload: { status: "succeeded" }, createdAt: "t" },
        ],
      }),
    };

    render(<App client={fakeClient([])} api={historyApi} />);

    // the persisted run is listed even though nothing is running now
    const runBtn = await screen.findByTestId("history-run-run-42");
    expect(runBtn).toHaveTextContent("build the login page");

    // clicking it restores the final status + full log from D1
    await userEvent.click(runBtn);
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("succeeded");
    });
    expect(screen.getByTestId("log")).toHaveTextContent("claude> DONE");
    expect(screen.getByTestId("viewing-past-run")).toBeInTheDocument();
  });
});
