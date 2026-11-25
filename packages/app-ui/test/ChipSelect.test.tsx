// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChipSelect, type ChipSelectOption } from "../src/index";

const OPTIONS: ChipSelectOption[] = [
  { value: "all", label: "全体" },
  { value: "role:lead", label: "統括" },
  { value: "person:hana", label: "花子" },
];

function Harness({ initial }: { initial: string[] }) {
  const [value, setValue] = useState(initial);
  return <ChipSelect value={value} onChange={setValue} options={OPTIONS} testId="cs" aria-label="対象" />;
}

const chips = () => screen.queryAllByTestId("cs-chip").map((c) => c.getAttribute("data-value"));

describe("ChipSelect", () => {
  it("after × hands focus back, the list still opens and Enter adds (the blur timer is cancelled)", async () => {
    render(<Harness initial={["all", "role:lead"]} />);
    await userEvent.click(screen.getByTestId("cs")); // typing in the field, then reaching for a chip ×
    await userEvent.click(screen.getByRole("button", { name: "全体 を外す" }));
    expect(screen.getByTestId("cs")).toHaveFocus();
    // Longer than the 120ms blur delay: a real person never types faster than that.
    await new Promise((r) => setTimeout(r, 200));
    await userEvent.keyboard("花");
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: /花子/ })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(chips()).toEqual(["role:lead", "person:hana"]);
  });
});
