/// <reference lib="dom" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import cssText from "@dub/tokens/css";
import "@dub/ui/style.css";
import { App } from "./App.tsx";
import { makeDemo } from "./lib/demo.ts";

// Inject design tokens as CSS variables (light + dark), matching the FE apps.
const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// VITE_COMMANDER_DEMO=1: sample board + in-memory PR API (no daemon/service/GitHub).
const demo = import.meta.env.VITE_COMMANDER_DEMO === "1" ? makeDemo() : null;

createRoot(rootEl).render(
  <StrictMode>
    <App {...(demo ? { api: demo.api, client: demo.client } : {})} />
  </StrictMode>,
);
