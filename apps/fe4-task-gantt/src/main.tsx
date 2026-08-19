import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import cssText from "@dub/tokens/css";
// @dub/ui resolves to its built dist here (no source alias like fe7), so the
// design-system's compiled stylesheet must be loaded explicitly or every
// Button/Modal/Select/Badge renders unstyled.
import "@dub/ui/style.css";
import { DemoApp } from "./DemoApp";
import { createDevClient } from "./dev-seed";
import { ApiError } from "./contracts/spa-shell";
import { useTaskStore } from "./store/useTaskStore";

// inject design tokens (@dub/tokens CSS variables) once
const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

// Dev/E2E only: `?tasks=N` pads the demo event to N tasks (F3 verification).
const padTo = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get("tasks")) || undefined : undefined;
const client = createDevClient(padTo ? { padTo } : {});

// Dev-only test seam (tree-shaken from production via import.meta.env.DEV): lets a
// real-browser E2E force the next mock mutation to fail so the error-handling UI
// (ErrorDialog) can be exercised end-to-end. Never present in a prod build.
if (import.meta.env.DEV) {
  (window as unknown as { __fe4?: unknown }).__fe4 = {
    failNext: (status: number, body: unknown) => {
      (client as unknown as { failNext: ApiError }).failNext = new ApiError(status, body as never);
    },
    storeSize: () => useTaskStore.getState().list().length,
  };
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <DemoApp client={client} />
    </StrictMode>,
  );
}
