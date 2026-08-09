import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox, DatePicker, Select, Switch, TextField } from "../src/components/Inputs";

describe("TextField", () => {
  it("emits the new string value on change", () => {
    const onChange = vi.fn();
    render(<TextField id="x" value="" onChange={onChange} testId="x" />);
    fireEvent.change(screen.getByTestId("x"), { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("reflects invalid via aria-invalid", () => {
    render(<TextField id="x" value="" onChange={() => {}} invalid testId="x" />);
    expect(screen.getByTestId("x")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("Select", () => {
  it("renders placeholder + options and emits value", async () => {
    const onChange = vi.fn();
    render(
      <Select
        id="s"
        value={null}
        onChange={onChange}
        placeholder="選択"
        testId="s"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
      />,
    );
    expect(screen.getByText("選択")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId("s"), "b");
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Checkbox / Switch", () => {
  it("checkbox toggles boolean", async () => {
    const onChange = vi.fn();
    render(<Checkbox id="c" checked={false} onChange={onChange} label="同意" testId="c" />);
    await userEvent.click(screen.getByTestId("c"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("switch exposes role=switch", () => {
    render(<Switch id="sw" checked onChange={() => {}} label="通知" testId="sw" />);
    expect(screen.getByTestId("sw")).toHaveAttribute("role", "switch");
  });
});

describe("DatePicker", () => {
  it("emits null when cleared", () => {
    const onChange = vi.fn();
    render(<DatePicker id="d" value="2026-08-09" onChange={onChange} testId="d" />);
    fireEvent.change(screen.getByTestId("d"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("emits the ISO date string on change", () => {
    const onChange = vi.fn();
    render(<DatePicker id="d" value={null} onChange={onChange} testId="d" />);
    fireEvent.change(screen.getByTestId("d"), { target: { value: "2026-12-25" } });
    expect(onChange).toHaveBeenCalledWith("2026-12-25");
  });
});
