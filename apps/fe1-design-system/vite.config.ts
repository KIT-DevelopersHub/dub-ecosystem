import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Vite library mode (FE1 §2 凍結案 1-1-2). d.ts is emitted separately by tsc
// (tsconfig.build.json) in the `build` script.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.tsx"),
        icons: resolve(__dirname, "src/icons.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "@dub/tokens",
        "lucide-react",
        "@dnd-kit/core",
        "@dnd-kit/sortable",
        "@dnd-kit/utilities",
      ],
    },
    sourcemap: true,
  },
});
