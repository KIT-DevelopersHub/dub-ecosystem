/// <reference lib="dom" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import cssText from "@dub/tokens/css";
import { App } from "./App.tsx";

// Inject design tokens as CSS variables (light + dark), matching the FE apps.
const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
