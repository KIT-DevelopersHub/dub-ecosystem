import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DraftRestoredNotice } from "../src/components/DraftRestoredNotice";

describe("DraftRestoredNotice", () => {
  it("renders nothing when not visible", () => {
    const { container } = render(
      <DraftRestoredNotice visible={false} onDiscard={vi.fn()} onKeep={vi.fn()} testId="n" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the message and wires 破棄 / 閉じる", () => {
    const onDiscard = vi.fn();
    const onKeep = vi.fn();
    render(<DraftRestoredNotice visible onDiscard={onDiscard} onKeep={onKeep} testId="n" />);
    expect(screen.getByTestId("n")).toHaveTextContent("下書きを復元しました");
    fireEvent.click(screen.getByTestId("n-discard"));
    expect(onDiscard).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("n-keep"));
    expect(onKeep).toHaveBeenCalledOnce();
  });
});
