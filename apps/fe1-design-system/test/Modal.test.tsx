import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog, Modal } from "../src/components/Modal";

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
