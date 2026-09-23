import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.tsx";
import type { CommanderClient, DaemonRunEvent } from "./lib/client.ts";

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

describe("<App>", () => {
  it("renders the prompt console idle", () => {
    render(<App client={fakeClient([])} />);
    expect(screen.getByLabelText("prompt")).toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent("status: idle");
  });

  it("streams run events into the log and reaches succeeded", async () => {
    const client = fakeClient([
      { type: "status", status: "running" },
      { type: "claude", data: { type: "result", result: "PONG" } },
      { type: "exit", code: 0 },
      { type: "status", status: "succeeded" },
    ]);
    render(<App client={client} />);

    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("succeeded");
    });
    expect(screen.getByTestId("log")).toHaveTextContent("claude> PONG");
    expect(client.startRun).toHaveBeenCalledOnce();
  });
});
