// @dub/ui Storybook preview — global light/dark theme toolbar + a11y.
//
// The theme toolbar (受入 #5) stamps `data-theme` on the preview root and applies
// the matching @dub/tokens CSS custom properties by REUSING the shipped
// `ThemeProvider` component (which sets `data-theme` + inlines `cssVariables[theme]`
// from @dub/tokens). No runtime CSS-in-JS / Tailwind — only static token vars
// (凍結案 1-1-6 / 1-4-2).
import React from "react";
import type { Preview } from "@storybook/react";
import { ThemeProvider } from "../src/components/ThemeProvider";
import type { ThemeName } from "../src/types";

// Toolbar: pick light or dark for every story.
export const globalTypes = {
  theme: {
    name: "Theme",
    description: "@dub/tokens theme (stamps data-theme on the preview root)",
    defaultValue: "light" satisfies ThemeName,
    toolbar: {
      title: "Theme",
      icon: "contrast",
      items: [
        { value: "light", title: "Light", icon: "sun" },
        { value: "dark", title: "Dark", icon: "moon" },
      ],
      dynamicTitle: true,
    },
  },
};

const preview: Preview = {
  parameters: {
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    a11y: {
      // axe runs against the themed preview root; report violations, don't fail hard.
      test: "todo",
    },
    layout: "fullscreen",
  },
  decorators: [
    (Story, context) => {
      const theme = (context.globals.theme as ThemeName) ?? "light";
      // Inner surface uses @dub/tokens vars so the dark theme is actually visible.
      const surface: React.CSSProperties = {
        background: "var(--dub-color-surface-base)",
        color: "var(--dub-color-text-primary)",
        fontFamily: "var(--dub-font-family-sans)",
        minHeight: "100vh",
        padding: "24px",
        boxSizing: "border-box",
      };
      return React.createElement(
        ThemeProvider,
        { theme },
        React.createElement("div", { style: surface, "data-sb-theme-surface": "" }, React.createElement(Story)),
      );
    },
  ],
};

export default preview;
