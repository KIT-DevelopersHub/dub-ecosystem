import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Form, FormField } from "../src/components/Form";
import { TextField } from "../src/components/Inputs";

function Controlled({ error, help }: { error?: string; help?: string }) {
  return (
    <FormField label="メール" htmlFor="email" required error={error} help={help}>
      <TextField id="email" value="" onChange={() => {}} testId="email-input" />
    </FormField>
  );
}

describe("FormField", () => {
  it("shows a required marker", () => {
    render(<Controlled />);
    expect(screen.getByText(/メール/)).toBeInTheDocument();
    expect(screen.getByText("*", { exact: false })).toBeInTheDocument();
  });

  it("wires aria-invalid and aria-describedby to the input on error", () => {
    render(<Controlled error="必須です" />);
    const input = screen.getByTestId("email-input");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toContain("email-error");
    const err = screen.getByRole("alert");
    expect(err).toHaveAttribute("id", "email-error");
    expect(err).toHaveTextContent("必須です");
  });

  it("links help text when no error", () => {
    render(<Controlled help="社用アドレス" />);
    const input = screen.getByTestId("email-input");
    expect(input.getAttribute("aria-describedby")).toContain("email-help");
    expect(input).not.toHaveAttribute("aria-invalid");
  });
});

describe("Form", () => {
  it("calls onSubmit and prevents default navigation", async () => {
    const onSubmit = vi.fn();
    render(
      <Form onSubmit={onSubmit} testId="f">
        <button type="submit">送信</button>
      </Form>,
    );
    await userEvent.click(screen.getByText("送信"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("a11y (P17): moves focus to the first invalid field after a failed submit", async () => {
    function Sample() {
      const [error, setError] = useState<string | undefined>(undefined);
      return (
        <Form onSubmit={() => setError("必須です")} testId="f">
          <FormField label="メール" htmlFor="email" {...(error ? { error } : {})}>
            <TextField id="email" value="" onChange={() => {}} testId="email-input" />
          </FormField>
          <button type="submit">送信</button>
        </Form>
      );
    }
    render(<Sample />);
    await userEvent.click(screen.getByText("送信"));
    const input = screen.getByTestId("email-input");
    await vi.waitFor(() => expect(input).toHaveFocus());
  });

  it("a11y (P17): scrolls the first invalid field into view (centered) after a failed submit", async () => {
    // jsdom はレイアウト/scrollIntoView を実装しないので明示的にスタブする。
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    function Sample() {
      const [error, setError] = useState<string | undefined>(undefined);
      return (
        <Form onSubmit={() => setError("必須です")} testId="f">
          <FormField label="メール" htmlFor="email" {...(error ? { error } : {})}>
            <TextField id="email" value="" onChange={() => {}} testId="email-input" />
          </FormField>
          <button type="submit">送信</button>
        </Form>
      );
    }
    render(<Sample />);
    await userEvent.click(screen.getByText("送信"));
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: "center", behavior: "smooth" }),
    );
  });

  it("a11y (P17): uses instant scroll (no smooth) when prefers-reduced-motion is set", async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);

    function Sample() {
      const [error, setError] = useState<string | undefined>(undefined);
      return (
        <Form onSubmit={() => setError("必須です")} testId="f">
          <FormField label="メール" htmlFor="email" {...(error ? { error } : {})}>
            <TextField id="email" value="" onChange={() => {}} testId="email-input" />
          </FormField>
          <button type="submit">送信</button>
        </Form>
      );
    }
    render(<Sample />);
    await userEvent.click(screen.getByText("送信"));
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");

    vi.unstubAllGlobals();
  });
});
