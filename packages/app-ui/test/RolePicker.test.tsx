// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RolePicker } from "../src/index";

const roles = [
  { id: "r1", name: "管理者" },
  { id: "r2", name: "編成担当" },
];

function Harness({ includeNone, value: v = "" }: { includeNone?: boolean; value?: string }) {
  const [value, setValue] = useState(v);
  return <RolePicker value={value} onChange={setValue} roles={roles} includeNone={includeNone} testId="role" />;
}

describe("RolePicker", () => {
  it("renders one option per role under the label", () => {
    render(<Harness />);
    expect(screen.getByText("ロール")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "管理者" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "編成担当" })).toBeInTheDocument();
  });

  it("prepends a 'none' option when includeNone is set", () => {
    render(<Harness includeNone />);
    expect(screen.getByRole("option", { name: "なし" })).toBeInTheDocument();
  });

  it("reports the selected role id via onChange", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("role"), { target: { value: "r2" } });
    expect((screen.getByTestId("role") as HTMLSelectElement).value).toBe("r2");
  });

  it("tolerates undefined roles (loading) without crashing", () => {
    render(<RolePicker value="" onChange={() => {}} roles={undefined} testId="role" />);
    expect(screen.getByText("ロール")).toBeInTheDocument();
  });
});
