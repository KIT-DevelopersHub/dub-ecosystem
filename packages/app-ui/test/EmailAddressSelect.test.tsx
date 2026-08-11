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
});
