import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { ApiClient } from "./contracts/spa-shell";
import { ApiClientProvider } from "./api/client-context";
import { TaskWorkspacePage } from "./components/TaskWorkspacePage";
import { MeTasksRoute, TaskRouteProvider } from "./routes/taskRoutes";
import { loadSelectedEvent } from "./domain/selected-event";
import { DEMO_EVENT_ID, DEMO_PERMISSIONS, DEMO_CURRENT_USER } from "./dev-seed";
import styles from "./styles/app.module.css";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

type DemoView = "mytasks" | "gantt";

export interface DemoAppProps {
  client: ApiClient;
}

/**
 * Standalone demo shell for `pnpm dev` — shows the revamped マイタスク hub as the
 * primary screen, with a toggle to the existing ガント workspace so no app is
 * removed. Both share one MockApiClient (dev-seed).
 */
export function DemoApp({ client }: DemoAppProps) {
  const [view, setView] = useState<DemoView>("mytasks");
  return (
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <ToastProvider>
          <div className={styles.demoShell}>
            <nav className={styles.demoNav} aria-label="デモ画面の切り替え">
              <span className={styles.demoBrand}>DevHub · タスク</span>
              <div className={styles.demoTabs}>
                <button
                  className={`${styles.demoTab} ${view === "mytasks" ? styles.demoTabActive : ""}`}
                  onClick={() => setView("mytasks")}
                  data-testid="demo-tab-mytasks"
                >
                  マイタスク
                </button>
                <button
                  className={`${styles.demoTab} ${view === "gantt" ? styles.demoTabActive : ""}`}
                  onClick={() => setView("gantt")}
                  data-testid="demo-tab-gantt"
                >
                  ガント
                </button>
              </div>
            </nav>
            <main className={styles.demoMain}>
              {view === "mytasks" ? (
                // Render the real shell route so the demo exercises the actual
                // wiring (MeTasksRoute fetches teams + events from the mock).
                <TaskRouteProvider
                  value={{ currentUserId: DEMO_CURRENT_USER, permissions: DEMO_PERMISSIONS }}
                >
                  <MeTasksRoute />
                </TaskRouteProvider>
              ) : (
                // Standalone demo has no URL router, so resume the last-selected event
                // from storage here (production does this via fe2's ガント landing
                // redirect) — proving the header switcher's choice survives navigating
                // away and back.
                <TaskWorkspacePage eventId={loadSelectedEvent() ?? DEMO_EVENT_ID} permissions={DEMO_PERMISSIONS} />
              )}
            </main>
          </div>
        </ToastProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
