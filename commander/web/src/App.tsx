import { Board } from "./Board.tsx";
import type { CommanderClient } from "./lib/client.ts";
import type { CommanderApi } from "./lib/commanderApi.ts";

interface AppProps {
  /** Exec-bridge client (commander-daemon). Omit to use the default HTTP client. */
  client?: CommanderClient;
  /** Phase-gate + board API (commander-service). Omit to use the default HTTP client. */
  api?: CommanderApi;
}

/** Standalone Commander page (commander/web dev/build). The board is the whole app:
 *  投入(composer) → 走行(lanes) → 確認/判断(drawer) → close. Inside Dub the same Board is
 *  embedded by apps/fe2-app-shell/src/features/commander without this chrome. */
export function App({ client, api }: AppProps) {
  return (
    <div
      style={{
        maxWidth: 1200,
        margin: "0 auto",
        padding: 24,
        fontFamily: "var(--dub-font-family-sans, system-ui, sans-serif)",
        color: "var(--dub-color-text-primary, #e6e6e6)",
        background: "var(--dub-color-surface-base, #0f1115)",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Commander</h1>
      <p style={{ opacity: 0.7, marginTop: 0, fontSize: 13 }}>
        ローカル Claude Code を Web から並行駆動する司令ボード — 投入・走行・確認・判断を1画面で
      </p>

      <Board {...(client ? { client } : {})} {...(api ? { api } : {})} />
    </div>
  );
}
