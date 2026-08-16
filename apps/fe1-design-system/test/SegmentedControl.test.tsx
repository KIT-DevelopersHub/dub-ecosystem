import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SegmentedControl } from "../src/components/SegmentedControl";

const opts = [
  { value: "list", label: "リスト" },
  { value: "board", label: "ボード" },
  { value: "gantt", label: "ガント" },
] as const;

describe("SegmentedControl", () => {
  it("renders a tablist of tabs and labels it", () => {
    render(<SegmentedControl aria-label="表示" options={[...opts]} testId="sc" />);
    const strip = screen.getByTestId("sc");
    expect(strip).toHaveAttribute("role", "tablist");
    expect(strip).toHaveAttribute("aria-label", "表示");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("auto-selects the first enabled option when uncontrolled (never blank)", () => {
    render(<SegmentedControl aria-label="v" options={[{ value: "a", label: "A", disabled: true }, { value: "b", label: "B" }]} />);
    // first option is disabled, so selection falls to the first ENABLED one
    expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "A" })).toHaveAttribute("aria-selected", "false");
  });

  it("honours defaultValue on mount (uncontrolled)", () => {
    render(<SegmentedControl aria-label="v" defaultValue="gantt" options={[...opts]} />);
    expect(screen.getByRole("tab", { name: "ガント" })).toHaveAttribute("aria-selected", "true");
  });

  it("updates its own selection on click when uncontrolled and fires onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SegmentedControl aria-label="v" options={[...opts]} onChange={onChange} />);
    await user.click(screen.getByRole("tab", { name: "ボード" }));
    expect(onChange).toHaveBeenCalledWith("board");
    expect(screen.getByRole("tab", { name: "ボード" })).toHaveAttribute("aria-selected", "true");
  });

  it("is controlled by value: selection follows the prop, not internal state", async () => {
    const user = userEvent.setup();
    function Ctrl() {
      const [v, setV] = useState<"list" | "board" | "gantt">("list");
      return (
        <>
          <SegmentedControl aria-label="v" value={v} onChange={setV} options={[...opts]} />
          <span data-testid="cur">{v}</span>
        </>
      );
    }
    render(<Ctrl />);
    expect(screen.getByRole("tab", { name: "リスト" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "ガント" }));
    expect(screen.getByTestId("cur")).toHaveTextContent("gantt");
    expect(screen.getByRole("tab", { name: "ガント" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not select a disabled option", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SegmentedControl
        aria-label="v"
        defaultValue="list"
        onChange={onChange}
        options={[{ value: "list", label: "リスト" }, { value: "board", label: "ボード", disabled: true }]}
      />,
    );
    const disabled = screen.getByRole("tab", { name: "ボード" });
    expect(disabled).toBeDisabled();
    await user.click(disabled);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a caption and per-option testId", () => {
    render(
      <SegmentedControl
        caption="表示切替"
        captionTestId="sc-cap"
        options={[{ value: "a", label: "A", testId: "sc-opt-a" }]}
      />,
    );
    expect(screen.getByTestId("sc-cap")).toHaveTextContent("表示切替");
    expect(screen.getByTestId("sc-opt-a")).toBeInTheDocument();
  });

  it("reflects aria-controls + aria-expanded only when an option declares `controls`", () => {
    render(
      <SegmentedControl
        aria-label="v"
        defaultValue="a"
        options={[
          { value: "a", label: "A", controls: "panel-a" },
          { value: "b", label: "B", controls: "panel-b" },
        ]}
      />,
    );
    const a = screen.getByRole("tab", { name: "A" });
    const b = screen.getByRole("tab", { name: "B" });
    expect(a).toHaveAttribute("aria-controls", "panel-a");
    expect(a).toHaveAttribute("aria-expanded", "true");
    expect(b).toHaveAttribute("aria-expanded", "false");
  });

  it("omits aria-expanded for pure tab semantics (no `controls`)", () => {
    render(<SegmentedControl aria-label="v" options={[...opts]} />);
    expect(screen.getByRole("tab", { name: "リスト" })).not.toHaveAttribute("aria-expanded");
  });

  it("uses roving tabindex and moves focus with arrow keys (skipping disabled)", async () => {
    const user = userEvent.setup();
    render(
      <SegmentedControl
        aria-label="v"
        defaultValue="list"
        options={[{ value: "list", label: "リスト" }, { value: "board", label: "ボード", disabled: true }, { value: "gantt", label: "ガント" }]}
      />,
    );
    const list = screen.getByRole("tab", { name: "リスト" });
    const gantt = screen.getByRole("tab", { name: "ガント" });
    // only the selected tab is in the tab order
    expect(list).toHaveAttribute("tabindex", "0");
    expect(gantt).toHaveAttribute("tabindex", "-1");
    list.focus();
    await user.keyboard("{ArrowRight}"); // skips the disabled "ボード", lands on ガント
    expect(gantt).toHaveFocus();
    await user.keyboard("{Home}");
    expect(list).toHaveFocus();
  });
});
