import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ToastProvider } from "@dub/ui";
import { useUndoableAction, type UndoableActionInput } from "../src/hooks/useUndoableAction";

function Harness({ input, onReady }: { input: UndoableActionInput; onReady?: (a: ReturnType<typeof useUndoableAction>) => void }) {
  const api = useUndoableAction();
  onReady?.(api);
  return (
    <button type="button" onClick={() => api.run(input)}>
      go
    </button>
  );
}

function make(overrides: Partial<UndoableActionInput> = {}) {
  const apply = vi.fn();
  const restore = vi.fn();
  const commit = vi.fn(() => Promise.resolve());
  const input: UndoableActionInput = {
    apply,
    restore,
    commit,
    message: "削除しました",
    delayMs: 5000,
    ...overrides,
  };
  return { apply, restore, commit, input };
}

describe("useUndoableAction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("applies immediately and commits after the grace window", () => {
    const { apply, restore, commit, input } = make();
    render(
      <ToastProvider>
        <Harness input={input} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByTestId("toast-info")).toBeInTheDocument();
    expect(screen.getByTestId("toast-action-info")).toHaveTextContent("元に戻す");

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
  });

  it("undo restores and never commits", () => {
    const { apply, restore, commit, input } = make();
    render(
      <ToastProvider>
        <Harness input={input} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(apply).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(screen.getByTestId("toast-action-info"));
    });
    expect(restore).toHaveBeenCalledTimes(1);

    // even after the window elapses, commit must not run
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("flushPending commits in-flight actions immediately", () => {
    const { commit, input } = make();
    let api: ReturnType<typeof useUndoableAction> | undefined;
    render(
      <ToastProvider>
        <Harness input={input} onReady={(a) => (api = a)} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(commit).not.toHaveBeenCalled();
    act(() => {
      api!.flushPending();
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("calls onCommitError when commit rejects", async () => {
    const onCommitError = vi.fn();
    const boom = new Error("nope");
    const { input } = make({ commit: () => Promise.reject(boom), onCommitError });
    render(
      <ToastProvider>
        <Harness input={input} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(onCommitError).toHaveBeenCalledWith(boom);
  });

  it("commits pending actions on unmount (never silently dropped)", () => {
    const { commit, input } = make();
    const { unmount } = render(
      <ToastProvider>
        <Harness input={input} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(commit).not.toHaveBeenCalled();
    unmount();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
