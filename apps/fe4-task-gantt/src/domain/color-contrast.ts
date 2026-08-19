// Pick a legible text colour (near-black or white) to sit on an arbitrary solid
// background, using the WCAG relative-luminance contrast ratio. Used by the gantt
// sort-group brackets: the bracket is filled with the team/priority colour and the
// label text must stay readable whether that fill is light (→ dark text) or dark
// (→ white text). Pure, dependency-free, and tolerant of malformed input.
//
// Text colours are drawn from @dub/tokens (gray.900 / white) so the two poles match
// the design system rather than pure #000.

/** @dub/tokens gray.900 — the "dark text" pole. */
export const CONTRAST_TEXT_DARK = "#1a1e28";
/** White — the "light text" pole. */
export const CONTRAST_TEXT_LIGHT = "#ffffff";

/** Parse #rgb / #rrggbb (with or without leading #) → 0..255 channels, or null. */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** WCAG relative luminance (0 = black … 1 = white) of an sRGB colour. */
function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const chan = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/**
 * Return the text colour (dark or white) with the higher WCAG contrast ratio against
 * `background`. Falls back to dark text for an unparseable background so text never
 * vanishes. `background` accepts a hex string; anything else → dark text.
 */
export function readableTextColor(background: string | undefined | null): string {
  if (!background) return CONTRAST_TEXT_DARK;
  const rgb = parseHex(background);
  if (!rgb) return CONTRAST_TEXT_DARK;
  const L = relativeLuminance(rgb);
  // Contrast ratio (WCAG): (Llighter + 0.05) / (Ldarker + 0.05). White L=1, black L=0.
  const contrastWithWhite = (1 + 0.05) / (L + 0.05);
  const contrastWithBlack = (L + 0.05) / (0 + 0.05);
  return contrastWithWhite >= contrastWithBlack ? CONTRAST_TEXT_LIGHT : CONTRAST_TEXT_DARK;
}
