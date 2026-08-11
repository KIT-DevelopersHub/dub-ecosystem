// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DialogActions, FormError } from "../src/index";

describe("DialogActions", () => {
  it("renders its children and defaults to end alignment", () => {
    render(
      <DialogActions testId="acts">
        <button>Cancel</button>
        <button>OK</button>
      </DialogActions>,
    );
    const row = screen.getByTestId("acts");
    expect(row).toHaveAttribute("data-align", "end");
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("honors an explicit alignment", () => {
    render(<DialogActions align="between" testId="acts"><span /></DialogActions>);
    expect(screen.getByTestId("acts")).toHaveAttribute("data-align", "between");
  });
});

describe("FormError", () => {
  it("renders an alert with the message", () => {
    render(<FormError testId="err">失敗しました</FormError>);
    const el = screen.getByTestId("err");
    expect(el).toHaveAttribute("role", "alert");
    expect(el).toHaveTextContent("失敗しました");
  });

  it("renders nothing when empty/null", () => {
    const { container } = render(
      <>
        <FormError>{null}</FormError>
        <FormError>{""}</FormError>
        <FormError>{false}</FormError>
      </>,
    );
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});
