import { describe, it, expect } from "vitest";
import {
  SHORTCUTS,
  COMMAND_PALETTE_SHORTCUT,
  SHORTCUTS_HELP_SHORTCUT,
  formatChord,
  matchChord,
  type ShortcutChord,
} from "./registry.ts";

// A minimal KeyboardEvent-like shape for matchChord (it reads only these fields).
function ev(key: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) {
  return {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  } as KeyboardEvent;
}

describe("shortcut registry", () => {
  it("exposes the palette and help entries as the single source of truth", () => {
    expect(COMMAND_PALETTE_SHORTCUT.chord).toEqual({ mod: true, key: "K" });
    expect(SHORTCUTS_HELP_SHORTCUT.chord).toEqual({ key: "?" });
    // Both live in the same array the help dialog renders from.
    expect(SHORTCUTS).toContain(COMMAND_PALETTE_SHORTCUT);
    expect(SHORTCUTS).toContain(SHORTCUTS_HELP_SHORTCUT);
  });

  it("has unique ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("matchChord", () => {
  const cmdK: ShortcutChord = { mod: true, key: "K" };

  it("matches Cmd+K (mac) and Ctrl+K (win/linux) via the same entry", () => {
    expect(matchChord(ev("k", { meta: true }), cmdK)).toBe(true);
    expect(matchChord(ev("K", { ctrl: true }), cmdK)).toBe(true);
  });

  it("rejects the bare key without the modifier", () => {
    expect(matchChord(ev("k"), cmdK)).toBe(false);
  });

  it("rejects when Alt is held (chord does not ask for Alt)", () => {
    expect(matchChord(ev("k", { meta: true, alt: true }), cmdK)).toBe(false);
  });

  it("matches a bare '?' regardless of the shift that produced it", () => {
    expect(matchChord(ev("?"), SHORTCUTS_HELP_SHORTCUT.chord)).toBe(true);
    expect(matchChord(ev("?", { shift: true }), SHORTCUTS_HELP_SHORTCUT.chord)).toBe(true);
  });

  it("does not treat '?' as a mod chord", () => {
    expect(matchChord(ev("?", { ctrl: true }), SHORTCUTS_HELP_SHORTCUT.chord)).toBe(false);
  });
});

describe("formatChord", () => {
  it("renders ⌘ on mac and Ctrl elsewhere", () => {
    expect(formatChord({ mod: true, key: "K" }, "mac")).toEqual(["⌘", "K"]);
    expect(formatChord({ mod: true, key: "K" }, "other")).toEqual(["Ctrl", "K"]);
  });

  it("orders modifiers mod, alt, shift then the key", () => {
    expect(formatChord({ mod: true, alt: true, shift: true, key: "p" }, "mac")).toEqual(["⌘", "⌥", "⇧", "P"]);
    expect(formatChord({ mod: true, alt: true, shift: true, key: "p" }, "other")).toEqual([
      "Ctrl",
      "Alt",
      "Shift",
      "P",
    ]);
  });

  it("passes '?' through unchanged", () => {
    expect(formatChord({ key: "?" }, "mac")).toEqual(["?"]);
  });
});
