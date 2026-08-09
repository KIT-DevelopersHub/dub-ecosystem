import type { CSSProperties } from "react";
import { cssVariables } from "@dub/tokens";
import type { ThemeProviderProps } from "../types";

/**
 * Controlled theme boundary (凍結案 1-4-2). Sets `data-theme` and applies the
 * theme's CSS custom properties inline so components render correctly even
 * without the global `@dub/tokens/css` stylesheet. It NEVER persists — "system"
 * resolution + localStorage("dub.ui.theme") are owned by FE2 UiStore.
 */
export function ThemeProvider({ theme, children }: ThemeProviderProps) {
  const style = cssVariables[theme] as unknown as CSSProperties;
  return (
    <div data-theme={theme} data-dub-theme-root="" style={style}>
      {children}
    </div>
  );
}
