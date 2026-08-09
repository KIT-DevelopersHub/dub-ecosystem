import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { cssText } from "@dub/tokens/css";
import { App } from "./App";

// Inject @dub/tokens CSS variables (light + dark) for the standalone harness.
const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
