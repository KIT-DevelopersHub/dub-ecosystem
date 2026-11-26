// #900: 「すべて既読にする」 is the standard outlined @dub/ui Button, not bare text.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkAllReadButton } from "../src/components/MarkAllReadButton";

describe("MarkAllReadButton (#900)", () => {
  it("renders the @dub/ui secondary button and fires onClick", async () => {
    const onClick = vi.fn();
    render(<MarkAllReadButton onClick={onClick} />);
    const btn = screen.getByTestId("fe5-inbox-markall");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("data-variant", "secondary");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stays disabled when everything is read", () => {
    render(<MarkAllReadButton onClick={() => {}} disabled />);
    expect(screen.getByTestId("fe5-inbox-markall")).toBeDisabled();
  });
});
