import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.tsx";
import type { CommanderClient, DaemonRunEvent } from "./lib/client.ts";
import type { CommanderApi } from "./lib/commanderApi.ts";

function fakeClient(events: DaemonRunEvent[]): CommanderClient {
  return {
    startRun: vi.fn(async () => ({ runId: "run-1" })),
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
});
