import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, IconButton } from "../src/components/Button";

describe("Button", () => {
  it("applies variant and size as data attributes", () => {
    render(
      <Button variant="danger" size="lg" testId="t">
        Delete
      </Button>,
    );
    const btn = screen.getByTestId("t");
    expect(btn).toHaveAttribute("data-variant", "danger");
    expect(btn).toHaveAttribute("data-size", "lg");
  });

  it("defaults to primary/md", () => {
    render(<Button testId="t">Go</Button>);
    const btn = screen.getByTestId("t");
    expect(btn).toHaveAttribute("data-variant", "primary");
    expect(btn).toHaveAttribute("data-size", "md");
  });

  it("does not fire onClick while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick} testId="t">
        Save
      </Button>,
    );
    const btn = screen.getByTestId("t");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not fire onClick when disabled and sets disabled attr", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick} testId="t">
        Save
      </Button>,
    );
    await userEvent.click(screen.getByTestId("t"));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByTestId("t")).toBeDisabled();
  });

  it("fires onClick when enabled", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} testId="t">
        Save
      </Button>,
    );
    await userEvent.click(screen.getByTestId("t"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  describe("success flash (P12)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows a checkmark and data-success on the rising edge, then reverts automatically", () => {
      vi.useFakeTimers();
      const { rerender } = render(
        <Button testId="t" success={false}>
          Save
        </Button>,
      );
      const btn = screen.getByTestId("t");
      expect(btn).not.toHaveAttribute("data-success");

      rerender(
        <Button testId="t" success>
          Save
        </Button>,
      );
      expect(btn).toHaveAttribute("data-success");
      expect(btn.querySelector('[data-icon="check"]')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(btn).not.toHaveAttribute("data-success");
    });

    it("does not show the checkmark while loading, even if success is true", () => {
      render(
        <Button testId="t" loading success>
          Save
        </Button>,
      );
      const btn = screen.getByTestId("t");
      expect(btn).not.toHaveAttribute("data-success");
      expect(btn.querySelector('[data-icon="check"]')).toBeNull();
    });

    it("does not re-flash on re-renders while success stays true", () => {
      vi.useFakeTimers();
      const { rerender } = render(
        <Button testId="t" success>
          Save
        </Button>,
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByTestId("t")).not.toHaveAttribute("data-success");

      // Re-render with the same success=true (e.g. a parent re-render) must not
      // restart the flash — only a false→true edge should.
      rerender(
        <Button testId="t" success>
          Save
        </Button>,
      );
      expect(screen.getByTestId("t")).not.toHaveAttribute("data-success");
    });
  });
});

describe("IconButton", () => {
  it("requires and exposes aria-label", () => {
    render(<IconButton name="trash" aria-label="削除" testId="t" />);
    expect(screen.getByTestId("t")).toHaveAttribute("aria-label", "削除");
  });
});
