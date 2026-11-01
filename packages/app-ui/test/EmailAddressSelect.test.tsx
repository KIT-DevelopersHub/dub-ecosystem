// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { EmailAddressSelect } from "../src/index";
import type { EmailParseResult } from "../src/index";

// Minimal parser mirroring FE2 mail `parseRecipients` (Name <email> | bare email).
function parse(raw: string): EmailParseResult {
  const recipients: { email: string; name?: string }[] = [];
  const invalid: string[] = [];
  for (const tok of raw.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean)) {
    const m = /^(.*?)<([^>]+)>$/.exec(tok);
    const name = m ? m[1]!.trim() : "";
    const email = (m ? m[2]! : tok).trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) recipients.push(name ? { email, name } : { email });
    else invalid.push(tok);
  }
  return { recipients, invalid };
}

function Harness({ candidates, initial = "" }: { candidates?: { email: string; name?: string }[]; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <EmailAddressSelect value={value} onChange={setValue} parse={parse} candidates={candidates} testId="to" label="To" />
  );
}

describe("EmailAddressSelect", () => {
  it("commits a typed address into a chip on Enter", () => {
    render(<Harness />);
    const input = screen.getByTestId("to");
    fireEvent.change(input, { target: { value: "a@b.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does NOT commit on the IME 変換確定 Enter, but commits on the plain Enter after", () => {
    render(<Harness />);
    const input = screen.getByTestId("to");
    fireEvent.change(input, { target: { value: "a@b.com" } });
    // 変換確定 Enter (composing) — must not turn into a chip.
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(screen.queryByText("a@b.com")).not.toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("a@b.com");
    // Plain Enter after 確定 — commits.
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
  });

  it("commits on comma and renders the display name for named addresses", () => {
    render(<Harness initial="Ann <ann@x.com>" />);
    expect(screen.getByText("Ann")).toBeInTheDocument();
  });

  it("removes a chip via its delete button", () => {
    render(<Harness initial="a@b.com, c@d.com" />);
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("a@b.com を削除"));
    expect(screen.queryByText("a@b.com")).not.toBeInTheDocument();
    expect(screen.getByText("c@d.com")).toBeInTheDocument();
  });

  it("flags an invalid token as an invalid chip", () => {
    render(<Harness initial="not-an-email" />);
    const chip = screen.getByText("not-an-email").closest("span")!;
    expect(chip).toHaveAttribute("data-invalid", "true");
  });

  it("shows candidate suggestions and adds one on click", () => {
    render(<Harness candidates={[{ email: "team@dev.jp", name: "Team" }]} />);
    const input = screen.getByTestId("to");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "tea" } });
    const listbox = screen.getByRole("listbox");
    fireEvent.mouseDown(within(listbox).getByRole("option"));
    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("does not render a listbox when no candidates are provided", () => {
    render(<Harness />);
    const input = screen.getByTestId("to");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "x" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  describe("keyboard selection of suggestions", () => {
    const people = [
      { email: "sato@dev.jp", name: "Sato" },
      { email: "suzuki@dev.jp", name: "Suzuki" },
      { email: "sasaki@dev.jp", name: "Sasaki" },
    ];
    const open = (q = "s") => {
      render(<Harness candidates={people} />);
      const input = screen.getByTestId("to");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: q } });
      return input;
    };
    const activeName = () =>
      within(screen.getByRole("listbox")).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.textContent;

    it("highlights the first match by default and exposes combobox aria", () => {
      const input = open();
      expect(input).toHaveAttribute("role", "combobox");
      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(activeName()).toContain("Sato");
      const first = within(screen.getByRole("listbox")).getAllByRole("option")[0]!;
      expect(input).toHaveAttribute("aria-activedescendant", first.id);
    });

    it("ArrowDown/ArrowUp move the highlight with wrap-around", () => {
      const input = open();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(activeName()).toContain("Suzuki");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(activeName()).toContain("Sato"); // wrapped past the end
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(activeName()).toContain("Sasaki"); // wrapped past the start
    });

    it("Enter picks the highlighted suggestion as a chip and closes the list", () => {
      const input = open();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByText("Suzuki")).toBeInTheDocument();
      expect((input as HTMLInputElement).value).toBe("");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("Tab also picks the highlighted suggestion", () => {
      const input = open();
      fireEvent.keyDown(input, { key: "Tab" });
      expect(screen.getByText("Sato")).toBeInTheDocument();
    });

    it("Escape closes the list but keeps the typed text", () => {
      const input = open("su");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect((input as HTMLInputElement).value).toBe("su");
      expect(input).toHaveAttribute("aria-expanded", "false");
      // Typing again reopens it.
      fireEvent.change(input, { target: { value: "suz" } });
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    it("mouse hover syncs the highlight", () => {
      open();
      const options = within(screen.getByRole("listbox")).getAllByRole("option");
      fireEvent.mouseEnter(options[2]!);
      expect(activeName()).toContain("Sasaki");
    });

    it("ignores arrows/Enter while an IME is composing", () => {
      const input = open();
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
      expect(activeName()).toContain("Sato");
      expect(screen.queryByLabelText("sato@dev.jp を削除")).not.toBeInTheDocument();
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect((input as HTMLInputElement).value).toBe("s");
    });

    it("Enter on a complete new address adds the typed address, not a suggestion", () => {
      render(<Harness candidates={[{ email: "sato@dev.jp.example", name: "Sato" }]} />);
      const input = screen.getByTestId("to");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "sato@dev.jp" } });
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(activeName()).toBeUndefined();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByText("sato@dev.jp")).toBeInTheDocument();
      expect(screen.queryByText("Sato")).not.toBeInTheDocument();
    });

    it("an exactly-matching suggestion is still highlighted and picked with its name", () => {
      render(<Harness candidates={[{ email: "sato@dev.jp", name: "Sato" }]} />);
      const input = screen.getByTestId("to");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "sato@dev.jp" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByText("Sato")).toBeInTheDocument();
    });
  });
});
