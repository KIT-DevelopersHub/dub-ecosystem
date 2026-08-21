import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitForElementToBeRemoved } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider, useToast } from "../src/components/Toast";
import type { ToastOptions } from "../src/types";

function Trigger({ opts }: { opts: ToastOptions }) {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show(opts)}>
      show
    </button>
  );
}

function renderWith(opts: ToastOptions) {
  return render(
    <ToastProvider>
      <Trigger opts={opts} />
    </ToastProvider>,
  );
}

describe("useToast", () => {
  it("throws when used outside a provider", () => {
    const Bad = () => {
      useToast();
      return null;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});

describe("ToastProvider", () => {
  it("shows a toast on show() for each kind", async () => {
    renderWith({ kind: "warning", title: "注意" });
    await userEvent.click(screen.getByText("show"));
    expect(screen.getByTestId("toast-warning")).toBeInTheDocument();
    expect(screen.getByText("注意")).toBeInTheDocument();
  });

  it("error toast has role=alert and can be dismissed", async () => {
    renderWith({ kind: "error", title: "失敗" });
    await userEvent.click(screen.getByText("show"));
    const toast = screen.getByTestId("toast-error");
    expect(toast).toHaveAttribute("role", "alert");
    await userEvent.click(screen.getByLabelText("通知を閉じる"));
    // A01: dismissal is two-phase — the toast enters a `leaving` state (exit
    // animation) and is unmounted after EXIT_MS.
    expect(toast).toHaveAttribute("data-leaving", "true");
    await waitForElementToBeRemoved(() => screen.queryByTestId("toast-error"));
  });
});

describe("ToastProvider (timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // fireEvent (synchronous) is used here instead of userEvent, which awaits real
  // time and would deadlock under fake timers.
  it("auto-dismisses non-error toasts after durationMs", () => {
    render(
      <ToastProvider>
        <Trigger opts={{ kind: "success", title: "OK", durationMs: 1000 }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("show"));
    expect(screen.getByTestId("toast-success")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // A01: auto-dismiss now enters a `leaving` state first; the node unmounts
    // after the exit phase (EXIT_MS).
    expect(screen.getByTestId("toast-success")).toHaveAttribute("data-leaving", "true");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("toast-success")).not.toBeInTheDocument();
  });

  it("error toast does NOT auto-dismiss", () => {
    render(
      <ToastProvider>
        <Trigger opts={{ kind: "error", title: "sticky" }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("show"));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("toast-error")).toBeInTheDocument();
  });
});
