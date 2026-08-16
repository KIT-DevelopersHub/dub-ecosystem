import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SearchInput } from "../src/components/SearchInput";

describe("SearchInput", () => {
  it("renders a labelled search field and emits typed value (immediate, no debounce)", () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} testId="q" aria-label="通知を検索" />);
    const input = screen.getByTestId("q-input");
    expect(input).toHaveAttribute("aria-label", "通知を検索");
    fireEvent.change(input, { target: { value: "gantt" } });
    expect(onChange).toHaveBeenCalledWith("gantt");
  });

  it("debounces onChange while typing when debounceMs is set", async () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} debounceMs={50} testId="q" />);
    const input = screen.getByTestId("q-input");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });
    // Not called synchronously (debounced), and only the final value lands once.
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("ab"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("shows a clear button once there is text and clears immediately", () => {
    const onChange = vi.fn();
    render(<SearchInput value="hello" onChange={onChange} testId="q" />);
    const clear = screen.getByTestId("q-clear");
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("hides the clear button when empty", () => {
    render(<SearchInput value="" onChange={() => {}} testId="q" />);
    expect(screen.queryByTestId("q-clear")).not.toBeInTheDocument();
  });
});
