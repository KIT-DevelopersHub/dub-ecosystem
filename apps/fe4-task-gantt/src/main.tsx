import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import cssText from "@dub/tokens/css";
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
