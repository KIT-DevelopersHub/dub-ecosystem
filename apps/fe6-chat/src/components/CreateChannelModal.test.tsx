import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CreateChannelModal } from "./CreateChannelModal";

describe("CreateChannelModal — IME Enter behavior", () => {
  it("does NOT create the channel on the IME 変換確定 Enter, but creates on the following plain Enter", () => {
    const onCreate = vi.fn();
    render(<CreateChannelModal open onClose={() => {}} onCreate={onCreate} />);
    const nameInput = screen.getByTestId("fe6-create-name");
    // Type a Japanese channel name via IME.
    fireEvent.change(nameInput, { target: { value: "プロジェクト" } });

    // 変換確定 Enter: keydown mid-composition (isComposing / keyCode 229) — must not submit.
    fireEvent.keyDown(nameInput, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onCreate).not.toHaveBeenCalled();

    // Plain Enter after confirming the conversion → creates.
    fireEvent.keyDown(nameInput, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
