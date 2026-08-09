// @dub/ui Storybook 8 — self-contained catalog (contract-neutral).
//
// NOTE(contract): this setup lives entirely inside the @dub/ui package and adds
// NOTHING to the public export surface (src/index.tsx) or the frozen Props
// contract (src/types.ts). It only reads existing components + @dub/tokens, so it
// is safe to add/remove without a CONTRACT_VERSION bump. Public hosting is out of
// scope (infra follow-up: `storybook.developershub.jp` + Cloudflare Access).
//
// Stack matches the package: React 18 + Vite library mode (@storybook/react-vite).
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/stories/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-essentials", // controls / docs / toolbars / viewport / backgrounds
    "@storybook/addon-a11y", // axe-core accessibility checks (受入 #4)
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  core: {
    // Local, self-contained build — no analytics phone-home.
    disableTelemetry: true,
  },
  typescript: {
    // react-docgen keeps prop tables in sync with src/types.ts contract shapes.
    reactDocgen: "react-docgen-typescript",
  },
};

export default config;
