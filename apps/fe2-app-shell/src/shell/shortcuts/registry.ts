// Keyboard-shortcut registry — the SINGLE SOURCE OF TRUTH for every global shortcut in
// the shell ([[dub-api-contract-sot]]: define once, never twice). Both the surface that
// *binds* a shortcut (CommandPalette's Cmd/Ctrl+K, ShortcutsDialog's "?") and the surface
// that *lists* them (the キーボードショートカット dialog) read this array, so adding a new
// entry here makes it work AND show up in the help list with zero extra wiring.
//
// A chord is described platform-neutrally (`mod` = Cmd on macOS / Ctrl elsewhere). Two
// pure helpers derive from it: matchChord() for the keydown handlers and formatChord()
// for the per-OS display tokens (⌘ vs Ctrl). Neither the binder nor the lister hardcodes
// a key combo — they all go through here.

/** A platform-neutral key chord. `mod` maps to ⌘ on macOS and Ctrl on Windows/Linux. */
export interface ShortcutChord {
  /** Cmd (macOS) / Ctrl (Windows/Linux). */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** The primary key, compared case-insensitively (e.g. "K", "?", "/"). */
  key: string;
}

export interface ShortcutDef {
  /** Stable id (used for list keys / test ids). */
  id: string;
  /** What the shortcut does, shown in the help list. */
  label: string;
  /** Category heading the shortcut groups under in the help list. */
  category: string;
  /** The key chord that triggers it. */
  chord: ShortcutChord;
}

// The registry. Order here is the order shown in the help dialog (within each category).
// Add a shortcut = add a row here (and bind it via matchChord in its owning component).
export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: "command-palette",
    label: "コマンドパレットを開く / 閉じる",
    category: "全般",
    chord: { mod: true, key: "K" },
  },
  {
    id: "shortcuts-help",
    label: "キーボードショートカット一覧を開く",
    category: "全般",
    chord: { key: "?" },
  },
] as const;

/** The palette toggle chord, pulled from the registry so the binder never redefines it. */
export const COMMAND_PALETTE_SHORTCUT = SHORTCUTS.find((s) => s.id === "command-palette")!;
/** The help-dialog chord, pulled from the registry (same reason). */
export const SHORTCUTS_HELP_SHORTCUT = SHORTCUTS.find((s) => s.id === "shortcuts-help")!;

export type Platform = "mac" | "other";

/** Detect the viewer's platform for key-symbol display. SSR-safe (defaults to "other"). */
export function getPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  // userAgentData.platform is the modern signal; fall back to the legacy platform/UA string.
  const uaPlatform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  const haystack = `${uaPlatform} ${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  return /mac|iphone|ipad|ipod/.test(haystack) ? "mac" : "other";
}

/**
 * True when a keydown event satisfies the chord. `mod` matches Cmd OR Ctrl (so the same
 * registry entry works on every OS). Shift is NOT required explicitly — it is already
 * baked into the produced key character (e.g. "?" needs Shift on many layouts) — so we
 * compare the resulting key case-insensitively and only enforce mod/alt.
 */
export function matchChord(e: KeyboardEvent | React.KeyboardEvent, chord: ShortcutChord): boolean {
  const modDown = e.metaKey || e.ctrlKey;
  if (Boolean(chord.mod) !== modDown) return false;
  if (Boolean(chord.alt) !== e.altKey) return false;
  return e.key.toLowerCase() === chord.key.toLowerCase();
}

/** Human-readable key tokens for a chord, per platform (e.g. ["⌘","K"] / ["Ctrl","K"]). */
export function formatChord(chord: ShortcutChord, platform: Platform): string[] {
  const tokens: string[] = [];
  if (chord.mod) tokens.push(platform === "mac" ? "⌘" : "Ctrl");
  if (chord.alt) tokens.push(platform === "mac" ? "⌥" : "Alt");
  if (chord.shift) tokens.push(platform === "mac" ? "⇧" : "Shift");
  tokens.push(formatKey(chord.key));
  return tokens;
}

// Display a raw key: single letters upper-cased, a few named keys spelled out, the rest
// passed through (so "?" renders as "?").
function formatKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  const named: Record<string, string> = {
    " ": "Space",
    escape: "Esc",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    enter: "Enter",
  };
  return named[key.toLowerCase()] ?? key;
}
