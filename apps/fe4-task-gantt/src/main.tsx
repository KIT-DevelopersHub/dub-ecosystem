import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import cssText from "@dub/tokens/css";
// @dub/ui resolves to its built dist here (no source alias like fe7), so the
// design-system's compiled stylesheet must be loaded explicitly or every
// Button/Modal/Select/Badge renders unstyled.
import "@dub/ui/style.css";
import { App } from "./App";
import { createDevClient, DEMO_EVENT_ID, DEMO_PERMISSIONS } from "./dev-seed";

// inject design tokens (@dub/tokens CSS variables) once
const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App client={createDevClient()} eventId={DEMO_EVENT_ID} permissions={DEMO_PERMISSIONS} />
    </StrictMode>,
  );
}
