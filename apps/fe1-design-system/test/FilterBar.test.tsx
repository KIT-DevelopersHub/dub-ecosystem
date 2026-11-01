import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterBar, FilterChip, FilterChips } from "../src/components/FilterBar";

const opts = [
  { value: "a", label: "A", testId: "chip-a", count: 3, countTestId: "count-a" },
  { value: "b", label: "B", testId: "chip-b" },
  { value: "c", label: "C", testId: "chip-c", disabled: true },
] as const;

describe("FilterBar", () => {
  it("renders a labelled group with the default lead label and no badge/clear when inactive", () => {
    render(
      <FilterBar testId="bar" aria-label="絞り込み" onClear={() => {}} clearTestId="clear" activeCountTestId="n">
        <span />
      </FilterBar>,
    );
    const bar = screen.getByTestId("bar");
    expect(bar).toHaveAttribute("role", "group");
    expect(bar).toHaveAttribute("aria-label", "絞り込み");
    expect(bar).toHaveTextContent("フィルタ");
    expect(screen.queryByTestId("n")).toBeNull();
    expect(screen.queryByTestId("clear")).toBeNull();
  });

  it("shows the active count and クリア, which calls onClear", async () => {
    const onClear = vi.fn();
    render(
      <FilterBar activeCount={2} activeCountTestId="n" onClear={onClear} clearTestId="clear">
        <span />
      </FilterBar>,
    );
    expect(screen.getByTestId("n")).toHaveTextContent("2");
    await userEvent.click(screen.getByTestId("clear"));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe("FilterChips", () => {
  it("multiple: toggles values in and out with aria-pressed", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterChips multiple options={opts} value={[]} onChange={onChange} />);
    expect(screen.getByTestId("chip-a")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByTestId("chip-a"));
    expect(onChange).toHaveBeenLastCalledWith(["a"]);

    rerender(<FilterChips multiple options={opts} value={["a", "b"]} onChange={onChange} />);
    expect(screen.getByTestId("chip-a")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("chip-a"));
    expect(onChange).toHaveBeenLastCalledWith(["b"]);
  });

  it("single: radiogroup semantics, selecting another value calls onChange, re-click is a no-op", async () => {
    function Harness({ spy }: { spy: (v: string) => void }) {
      const [v, setV] = useState<"a" | "b" | "c">("a");
      return (
        <FilterChips
          testId="grp"
          options={opts}
          value={v}
          onChange={(n) => {
            spy(n);
            setV(n);
          }}
        />
      );
    }
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    expect(screen.getByTestId("grp")).toHaveAttribute("role", "radiogroup");
    expect(screen.getByTestId("chip-a")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByTestId("chip-a"));
    expect(spy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("chip-b"));
    expect(spy).toHaveBeenCalledWith("b");
    expect(screen.getByTestId("chip-b")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("chip-a")).toHaveAttribute("aria-checked", "false");
  });

  it("renders per-option counts and respects disabled (option and group)", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterChips multiple options={opts} value={[]} onChange={onChange} />);
    expect(screen.getByTestId("count-a")).toHaveTextContent("3");
    expect(screen.getByTestId("chip-c")).toBeDisabled();
    rerender(<FilterChips multiple options={opts} value={[]} onChange={onChange} disabled />);
    expect(screen.getByTestId("chip-a")).toBeDisabled();
  });
});

describe("FilterChip", () => {
  it("is a pressed toggle that shows a check mark only when selected", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <FilterChip selected={false} onToggle={onToggle} testId="x">
        アーカイブ含む
      </FilterChip>,
    );
    expect(screen.getByTestId("x")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("x")).not.toHaveTextContent("✓");
    await userEvent.click(screen.getByTestId("x"));
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(
      <FilterChip selected onToggle={onToggle} testId="x">
        アーカイブ含む
      </FilterChip>,
    );
    expect(screen.getByTestId("x")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("x")).toHaveTextContent("✓");
  });
});
