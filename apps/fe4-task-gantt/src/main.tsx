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
// Demo shows the 3-level WBS nest so the 内包バー (parent-encloses-children) is
// visible end-to-end; `?flat=1` opts back to the plain 2-level real-data seed.
const deepNest = new URLSearchParams(location.search).get("flat") !== "1";
const client = createDevClient({ ...(padTo ? { padTo } : {}), deepNest });

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
  // Demo-only: pre-seed the 親/先行タスク検索の「最近選んだタスク」history so the
  // suggestion (frontmatter feature) is visible the instant you open the demo —
  // without having to first pick tasks twice. Only fills EMPTY keys so any real
  // selection the user makes still takes over. Ids are seeded top-level tasks.
  try {
    const seed = ["task_1_2", "task_1_3", "task_1_4"];
    for (const key of ["fe4:recent-parents", "fe4:recent-predecessors"]) {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed));
    }
  } catch {
    /* storage disabled — the empty-state placeholder still shows the feature */
  }
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <DemoApp client={client} />
    </StrictMode>,
  );
}
