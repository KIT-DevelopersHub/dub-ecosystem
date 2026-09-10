import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog, Drawer, ErrorDialog, Modal } from "../src/components/Modal";

describe("Modal", () => {
  it("does not render when closed", () => {
    render(
      <Modal open={false} onClose={() => {}} title="タイトル">
        body
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders as an accessible modal dialog when open", () => {
    render(
      <Modal open onClose={() => {}} title="タイトル" testId="m">
        body
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "タイトル");
  });

  it("calls onClose on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="タイトル">
        body
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose via the close button", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="タイトル">
        body
      </Modal>,
    );
    await userEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("respects closeOnOverlayClick=false", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="タイトル" closeOnOverlayClick={false}>
        body
      </Modal>,
    );
    // click the overlay (dialog's parent)
    const overlay = screen.getByRole("dialog").parentElement as HTMLElement;
    await userEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when the scrim (overlay) is clicked by default", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="タイトル">
        body
      </Modal>,
    );
    const overlay = screen.getByRole("dialog").parentElement as HTMLElement;
    // mouseDown on the scrim itself (not the dialog) triggers close
    await userEvent.pointer({ keys: "[MouseLeft>]", target: overlay });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders through a portal at document.body, escaping the render container", () => {
    const { container } = render(
      <Modal open onClose={() => {}} title="タイトル">
        body
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    // portal: the dialog is NOT inside the component's render container...
    expect(container).not.toContainElement(dialog);
    // ...but it is mounted under document.body.
    expect(document.body).toContainElement(dialog);
  });

  it("locks body scroll while open and restores it on close", () => {
    const { rerender } = render(
      <Modal open onClose={() => {}} title="タイトル">
        body
      </Modal>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    rerender(
      <Modal open={false} onClose={() => {}} title="タイトル">
        body
      </Modal>,
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("moves focus into the dialog on open (focus trap)", () => {
    render(
      <Modal open onClose={() => {}} title="タイトル">
        <button type="button">中身のボタン</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("focuses the first input field in the body on open, not the header close button", () => {
    render(
      <Modal open onClose={() => {}} title="タイトル">
        <input data-testid="dialog-initial-focus-target" placeholder="タイトル" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("dialog-initial-focus-target"));
    expect(document.activeElement).not.toBe(screen.getByLabelText("閉じる"));
  });

  it("focuses a textarea in the body when there is no earlier input", () => {
    render(
      <Modal open onClose={() => {}} title="タイトル">
        <textarea data-testid="dialog-initial-focus-textarea" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("dialog-initial-focus-textarea"));
  });

  it("focuses the FIRST of multiple input fields in the body", () => {
    render(
      <Modal open onClose={() => {}} title="タイトル">
        <input data-testid="dialog-initial-focus-first" />
        <input data-testid="dialog-initial-focus-second" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("dialog-initial-focus-first"));
  });

  it("skips disabled/readonly/hidden inputs and focuses the first usable one", () => {
    render(
      <Modal open onClose={() => {}} title="タイトル">
        <input type="hidden" data-testid="dialog-initial-focus-hidden" defaultValue="x" />
        <input disabled data-testid="dialog-initial-focus-disabled" />
        <input readOnly data-testid="dialog-initial-focus-readonly" defaultValue="x" />
        <input data-testid="dialog-initial-focus-usable" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("dialog-initial-focus-usable"));
  });

  it("falls back to the first focusable element (e.g. a button-only body) when there is no input", () => {
    // Regression guard: dialogs without any input field (ConfirmDialog-like bodies)
    // must keep the pre-existing "focus the first focusable element" behavior.
    render(
      <Modal open onClose={() => {}} title="タイトル">
        <button type="button">中身のボタン</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("Drawer", () => {
  it("focuses the first input field in the body on open, not the header close button", () => {
    render(
      <Drawer open onClose={() => {}} title="タイトル">
        <input data-testid="drawer-initial-focus-target" />
      </Drawer>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("drawer-initial-focus-target"));
    expect(document.activeElement).not.toBe(screen.getByLabelText("閉じる"));
  });

  it("falls back to focus-trap behavior when the body has no input", () => {
    render(
      <Drawer open onClose={() => {}} title="タイトル">
        <button type="button">中身のボタン</button>
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("ConfirmDialog", () => {
  it("prevents double execution while the async onConfirm is pending", async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <ConfirmDialog
        open
        title="削除しますか"
        message="元に戻せません"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const confirmBtn = screen.getByRole("button", { name: "確認" });
    await userEvent.click(confirmBtn);
    // pending -> button is disabled/loading, second click is a no-op
    expect(confirmBtn).toBeDisabled();
    await userEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledOnce();
    await act(async () => {
      resolve();
    });
  });
});

describe("ErrorDialog", () => {
  const error = { code: "TASK_VALIDATION_FAILED", message: "入力内容を確認してください", correlationId: "req_abc" };

  it("shows the failure reason, validation details and correlation id", () => {
    render(
      <ErrorDialog
        open
        error={error}
        details={[{ label: "期間", message: "期間（時期）が未入力です" }]}
        onClose={() => {}}
        testId="err"
      />,
    );
    expect(screen.getByTestId("err-message")).toHaveTextContent("入力内容を確認してください");
    expect(screen.getByTestId("err-details")).toHaveTextContent("期間（時期）が未入力です");
    expect(screen.getByRole("alert")).toHaveAttribute("data-error-code", "TASK_VALIDATION_FAILED");
    expect(screen.getByText(/req_abc/)).toBeInTheDocument();
  });

  it("close button invokes onClose", async () => {
    const onClose = vi.fn();
    render(<ErrorDialog open error={error} onClose={onClose} testId="err" />);
    await userEvent.click(screen.getByTestId("err-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders a retry button only when onRetry is given", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorDialog open error={error} onClose={() => {}} testId="err" />);
    expect(screen.queryByTestId("err-retry")).not.toBeInTheDocument();
    rerender(<ErrorDialog open error={error} onClose={() => {}} onRetry={onRetry} testId="err" />);
    await userEvent.click(screen.getByTestId("err-retry"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("is not rendered when closed", () => {
    render(<ErrorDialog open={false} error={error} onClose={() => {}} testId="err" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
