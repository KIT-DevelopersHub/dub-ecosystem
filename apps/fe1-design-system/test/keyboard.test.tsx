// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { isImeComposing, isSubmitEnter, useEnterToSubmit } from "../src/index";

describe("isImeComposing", () => {
  it("is true for a React-style event whose nativeEvent is composing", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
  });
  it("is true for the legacy keyCode 229 confirm keydown", () => {
    expect(isImeComposing({ nativeEvent: { keyCode: 229 } })).toBe(true);
  });
  it("is true for a native event that is composing", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
  });
  it("is false for a plain (non-composing) Enter", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
  });
});

describe("isSubmitEnter", () => {
  const ev = (over: Partial<KeyboardEvent> & { nativeEvent?: unknown } = {}) =>
    ({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, ...over }) as unknown as KeyboardEvent;
  it("true for a plain Enter", () => {
    expect(isSubmitEnter(ev())).toBe(true);
  });
  it("false for the 変換確定 Enter (composing)", () => {
    expect(isSubmitEnter(ev({ nativeEvent: { isComposing: true } } as never))).toBe(false);
  });
  it("false for Shift+Enter by default (newline)", () => {
    expect(isSubmitEnter(ev({ shiftKey: true }))).toBe(false);
  });
  it("true for Shift+Enter when allowShiftNewline=false", () => {
    expect(isSubmitEnter(ev({ shiftKey: true }), { allowShiftNewline: false })).toBe(true);
  });
  it("false for any non-Enter key", () => {
    expect(isSubmitEnter(ev({ key: "a" }))).toBe(false);
  });
});

function Field({ onSubmit }: { onSubmit: () => void }) {
  const enter = useEnterToSubmit<HTMLTextAreaElement>(() => onSubmit());
  return <textarea data-testid="f" {...enter} />;
}

describe("useEnterToSubmit", () => {
  it("submits on a plain Enter but not on the 変換確定 Enter", () => {
    const onSubmit = vi.fn();
    render(<Field onSubmit={onSubmit} />);
    const el = screen.getByTestId("f");

    fireEvent.compositionStart(el);
    fireEvent.keyDown(el, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.compositionEnd(el);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit on Shift+Enter (newline)", () => {
    const onSubmit = vi.fn();
    render(<Field onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByTestId("f"), { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
