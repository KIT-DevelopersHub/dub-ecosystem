// @dub/tokens — DevHub design tokens (P0b frozen shape; FE1 §2-1).
// 3 distribution forms: (a) TS constants (this module), (b) CSS variables
// (`@dub/tokens/css`), (c) W3C DTCG `tokens.json`.
//
// NOTE(α-11): brand color values are an initial extraction pending #7 designer
// review (P0b C-11 / ui-spec-needs-designer-confirm). Shape is frozen; values may
// still be tuned before CONTRACT_VERSION 1.0.0 sign-off.

export type ThemeName = "light" | "dark";

export interface ColorScale {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
}

export interface DubTokens {
  color: {
    brand: ColorScale;
    gray: ColorScale;
    success: ColorScale;
    warning: ColorScale;
    danger: ColorScale;
    info: ColorScale;
    surface: { base: string; raised: string; overlay: string; sunken: string };
    text: { primary: string; secondary: string; muted: string; inverse: string; link: string };
    border: { default: string; strong: string; focus: string };
  };
  space: {
    0: string; 1: string; 2: string; 3: string; 4: string; 5: string;
    6: string; 8: string; 10: string; 12: string; 16: string;
  };
  font: {
    family: { sans: string; mono: string };
    size: { xs: string; sm: string; md: string; lg: string; xl: string; "2xl": string; "3xl": string };
    weight: { regular: number; medium: number; bold: number };
    lineHeight: { tight: number; normal: number; relaxed: number };
  };
  radius: { none: string; sm: string; md: string; lg: string; full: string };
  shadow: { sm: string; md: string; lg: string; overlay: string };
  zIndex: { base: number; dropdown: number; sticky: number; modal: number; toast: number; tooltip: number };
  breakpoint: { sm: string; md: string; lg: string; xl: string };
  motion: { fast: string; normal: string; slow: string; easing: string };
}

const brand: ColorScale = {
  50: "#eef4ff", 100: "#dbe6ff", 200: "#bccfff", 300: "#8faeff", 400: "#5b82fb",
  500: "#3358e8", 600: "#2543c4", 700: "#1f379e", 800: "#1e3080", 900: "#1d2c66",
};
const gray: ColorScale = {
  50: "#f8f9fb", 100: "#eef0f4", 200: "#dde1e9", 300: "#c3cad6", 400: "#9aa4b6",
  500: "#6f7a90", 600: "#535d72", 700: "#3f4759", 800: "#2b3140", 900: "#1a1e28",
};
const success: ColorScale = {
  50: "#ecfdf3", 100: "#d1fadf", 200: "#a6f4c5", 300: "#6ce9a6", 400: "#32d583",
  500: "#12b76a", 600: "#039855", 700: "#027a48", 800: "#05603a", 900: "#054f31",
};
const warning: ColorScale = {
  50: "#fffaeb", 100: "#fef0c7", 200: "#fedf89", 300: "#fec84b", 400: "#fdb022",
  500: "#f79009", 600: "#dc6803", 700: "#b54708", 800: "#93370d", 900: "#7a2e0e",
};
const danger: ColorScale = {
  50: "#fef3f2", 100: "#fee4e2", 200: "#fecdca", 300: "#fda29b", 400: "#f97066",
  500: "#f04438", 600: "#d92d20", 700: "#b42318", 800: "#912018", 900: "#7a271a",
};
const info: ColorScale = {
  50: "#eff8ff", 100: "#d1e9ff", 200: "#b2ddff", 300: "#84caff", 400: "#53b1fd",
  500: "#2e90fa", 600: "#1570ef", 700: "#175cd3", 800: "#1849a9", 900: "#194185",
};

const sharedScales = { brand, gray, success, warning, danger, info };

const space: DubTokens["space"] = {
  0: "0", 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "20px",
  6: "24px", 8: "32px", 10: "40px", 12: "48px", 16: "64px",
};

const font: DubTokens["font"] = {
  family: {
    sans: "system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif",
    mono: "'SFMono-Regular', 'Menlo', 'Consolas', monospace",
  },
  size: { xs: "12px", sm: "14px", md: "16px", lg: "18px", xl: "20px", "2xl": "24px", "3xl": "30px" },
  weight: { regular: 400, medium: 500, bold: 700 },
  lineHeight: { tight: 1.2, normal: 1.5, relaxed: 1.75 },
};

const radius: DubTokens["radius"] = { none: "0", sm: "4px", md: "8px", lg: "12px", full: "9999px" };

const zIndex: DubTokens["zIndex"] = {
  base: 0, dropdown: 1000, sticky: 1100, modal: 1300, toast: 1400, tooltip: 1500,
};

const breakpoint: DubTokens["breakpoint"] = { sm: "640px", md: "768px", lg: "1024px", xl: "1280px" };

const motion: DubTokens["motion"] = {
  fast: "120ms",
  normal: "200ms",
  slow: "320ms",
  easing: "cubic-bezier(0.4, 0, 0.2, 1)",
};

const lightTokens: DubTokens = {
  color: {
    ...sharedScales,
    surface: { base: "#ffffff", raised: "#ffffff", overlay: "#ffffff", sunken: gray[50] },
    text: { primary: gray[900], secondary: gray[700], muted: gray[500], inverse: "#ffffff", link: brand[600] },
    border: { default: gray[200], strong: gray[300], focus: brand[500] },
  },
  space,
  font,
  radius,
  shadow: {
    sm: "0 1px 2px rgba(16,24,40,0.06)",
    md: "0 4px 8px rgba(16,24,40,0.08)",
    lg: "0 12px 24px rgba(16,24,40,0.12)",
    overlay: "0 20px 48px rgba(16,24,40,0.18)",
  },
  zIndex,
  breakpoint,
  motion,
};

const darkTokens: DubTokens = {
  color: {
    ...sharedScales,
    surface: { base: gray[900], raised: gray[800], overlay: gray[800], sunken: "#12151d" },
    text: { primary: gray[50], secondary: gray[200], muted: gray[400], inverse: gray[900], link: brand[300] },
    border: { default: gray[700], strong: gray[600], focus: brand[400] },
  },
  space,
  font,
  radius,
  shadow: {
    sm: "0 1px 2px rgba(0,0,0,0.4)",
    md: "0 4px 8px rgba(0,0,0,0.5)",
    lg: "0 12px 24px rgba(0,0,0,0.6)",
    overlay: "0 20px 48px rgba(0,0,0,0.7)",
  },
  zIndex,
  breakpoint,
  motion,
};

export const tokens: Record<ThemeName, DubTokens> = {
  light: lightTokens,
  dark: darkTokens,
};

/** Flatten a nested token object into `--dub-<path>` CSS custom-property entries. */
function flatten(obj: Record<string, unknown>, prefix: string, out: Record<string, string>): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}-${key}` : key;
    if (value !== null && typeof value === "object") {
      flatten(value as Record<string, unknown>, path, out);
    } else {
      out[`--dub-${path}`] = String(value);
    }
  }
}

function toCssVariables(t: DubTokens): Record<string, string> {
  const out: Record<string, string> = {};
  flatten(t as unknown as Record<string, unknown>, "", out);
  return out;
}

/** Distribution form (b): CSS custom-property maps keyed by theme. */
export const cssVariables: Record<ThemeName, Record<string, string>> = {
  light: toCssVariables(lightTokens),
  dark: toCssVariables(darkTokens),
};

/** Resolve a dotted token path (e.g. "color.brand.500") to a `var(--dub-...)` reference. */
export function toCssVarName(path: string): string {
  return `var(--dub-${path.replace(/\./g, "-")})`;
}
