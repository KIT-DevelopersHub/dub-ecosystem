import { describe, it, expect } from "vitest";
import { isImeComposing, isSubmitEnter } from "./keyboard.ts";

describe("isImeComposing", () => {
  it("is true while composing (isComposing / keyCode 229)", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeComposing({ keyCode: 229 })).toBe(true);
    expect(isImeComposing({ nativeEvent: { keyCode: 229 } })).toBe(true);
  });
  it("is false once composition is done", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe("isSubmitEnter", () => {
  it("submits on a plain Enter", () => {
    expect(isSubmitEnter({ key: "Enter", shiftKey: false })).toBe(true);
  });
  it("does NOT submit on the 変換確定 Enter (IME composing)", () => {
    expect(isSubmitEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isSubmitEnter({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
  });
  it("does NOT submit on Shift+Enter (newline)", () => {
    expect(isSubmitEnter({ key: "Enter", shiftKey: true })).toBe(false);
  });
  it("ignores non-Enter keys", () => {
    expect(isSubmitEnter({ key: "a", shiftKey: false })).toBe(false);
  });
});
