import { describe, it, expect, beforeEach } from "vitest";
import { loadNumberVisible, saveNumberVisible } from "../src/domain/task-number-pref";

const EVENT = "evt_test" as const;

describe("task-number visibility persistence", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it("defaults to visible (ON) when nothing is stored", () => {
    expect(loadNumberVisible(EVENT)).toBe(true);
  });

  it("persists OFF and reads it back", () => {
    saveNumberVisible(EVENT, false);
    expect(loadNumberVisible(EVENT)).toBe(false);
  });

  it("persists ON and reads it back", () => {
    saveNumberVisible(EVENT, false);
    saveNumberVisible(EVENT, true);
    expect(loadNumberVisible(EVENT)).toBe(true);
  });

  it("only an explicit 'false' hides it (garbage stays visible)", () => {
    globalThis.localStorage?.setItem(`fe4:gantt-number-visible:${EVENT}`, "garbage");
    expect(loadNumberVisible(EVENT)).toBe(true);
  });

  it("is scoped per event", () => {
    saveNumberVisible("evt_a", false);
    expect(loadNumberVisible("evt_a")).toBe(false);
    expect(loadNumberVisible("evt_b")).toBe(true);
  });
});
