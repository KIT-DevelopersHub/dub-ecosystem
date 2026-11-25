import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlockEditor } from "../src/blockeditor";
import type { BlockDoc } from "../src/blockeditor";

const initialDoc: BlockDoc = {
  version: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  blocks: [{ id: "b1", type: "text", span: 4, content: { text: "first" } }],
};

function setup() {
  localStorage.clear();
  render(<BlockEditor storageKey="undo-test" canWrite initialDoc={initialDoc} />);
  // Second block via the palette → one entry on the undo stack.
  fireEvent.click(screen.getByRole("button", { name: /テキスト/ }));
  const blocks = () => screen.getByTestId("fe3-blockeditor-canvas").children.length;
  expect(blocks()).toBe(2);
  return { blocks };
}

describe("BlockEditor Cmd+Z", () => {
  it("leaves blocks alone while typing in a block field", () => {
    const { blocks } = setup();
    fireEvent.doubleClick(screen.getByText("first"));
    const textarea = screen.getByDisplayValue("first");
    fireEvent.change(textarea, { target: { value: "first edited" } });
    fireEvent.keyDown(textarea, { key: "z", metaKey: true });
    expect(blocks()).toBe(2);
    expect(screen.getByDisplayValue("first edited")).toBeInTheDocument();
  });

  it("ignores Cmd+Z during IME composition", () => {
    const { blocks } = setup();
    fireEvent.keyDown(screen.getByTestId("fe3-blockeditor"), { key: "z", metaKey: true, isComposing: true });
    expect(blocks()).toBe(2);
  });

  it("still undoes the block change when focus is outside a field", () => {
    const { blocks } = setup();
    fireEvent.keyDown(screen.getByTestId("fe3-blockeditor"), { key: "z", metaKey: true });
    expect(blocks()).toBe(1);
  });
});
