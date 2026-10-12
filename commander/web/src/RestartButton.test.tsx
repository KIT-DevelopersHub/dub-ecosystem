import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RestartButton, type RestartClient } from "./RestartButton.tsx";

afterEach(() => vi.unstubAllGlobals());

function fakeClient(over: Partial<RestartClient> = {}): RestartClient {
  return {
    bootId: vi.fn().mockResolvedValue("boot-1"),
    restart: vi.fn().mockResolvedValue({ from: "aaa", to: "bbb" }),
    ...over,
  };
}

describe("<RestartButton>", () => {
  it("asks first, then restarts and reloads once the new daemon and web answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const bootId = vi.fn()
      .mockResolvedValueOnce("boot-1") // before
      .mockResolvedValueOnce(null) // stack down
      .mockResolvedValue("boot-2"); // new daemon
    const client = fakeClient({ bootId });
    const onRestarted = vi.fn();
    render(<RestartButton client={client} onRestarted={onRestarted} pollMs={1} />);

    await userEvent.click(screen.getByTestId("restart-open"));
    expect(client.restart).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("restart-confirm"));

    await vi.waitFor(() => expect(onRestarted).toHaveBeenCalledTimes(1));
    expect(client.restart).toHaveBeenCalledTimes(1);
  });

  it("shows why the daemon refused and lets the operator retry", async () => {
    const client = fakeClient({
      restart: vi.fn().mockRejectedValue(new Error("実行中のタスクが 2 件あるため再起動できません")),
    });
    const onRestarted = vi.fn();
    render(<RestartButton client={client} onRestarted={onRestarted} pollMs={1} />);

    await userEvent.click(screen.getByTestId("restart-open"));
    await userEvent.click(screen.getByTestId("restart-confirm"));

    expect(await screen.findByText("実行中のタスクが 2 件あるため再起動できません")).toBeInTheDocument();
    expect(screen.getByTestId("restart-open")).toBeInTheDocument();
    expect(onRestarted).not.toHaveBeenCalled();
  });

  it("gives up with a pointer to the log when the stack never comes back", async () => {
    const client = fakeClient({ bootId: vi.fn().mockResolvedValue("boot-1") });
    render(<RestartButton client={client} onRestarted={vi.fn()} pollMs={1} timeoutMs={20} />);

    await userEvent.click(screen.getByTestId("restart-open"));
    await userEvent.click(screen.getByTestId("restart-confirm"));

    expect(await screen.findByText(/restart\.log/)).toBeInTheDocument();
  });
});
