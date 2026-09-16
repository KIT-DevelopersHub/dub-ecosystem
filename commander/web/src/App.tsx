import { CommanderConsole } from "./CommanderConsole.tsx";
import type { CommanderClient } from "./lib/client.ts";
import { FeatureBoard } from "./FeatureBoard.tsx";
import type { CommanderApi } from "./lib/commanderApi.ts";

interface AppProps {
  /** Exec-bridge client (commander-daemon). Omit to use the default HTTP client. */
  client?: CommanderClient;
  /** Phase-gate API (commander-service). Omit to use the default HTTP client. */
  api?: CommanderApi;
}

/** Standalone Commander page (commander/web dev/build). Inside Dub the same pieces
 *  are embedded by apps/fe2-app-shell/src/features/commander without this chrome. */
export function App({ client, api }: AppProps) {
  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        color: "var(--color-text, #e6e6e6)",
        background: "var(--color-bg, #0f1115)",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Commander</h1>
      <p style={{ opacity: 0.7, marginTop: 0, fontSize: 13 }}>
        ローカル Claude Code を Web から駆動する司令コンソール（基盤 PoC）
      </p>

      <CommanderConsole {...(client ? { client } : {})} />
      <FeatureBoard {...(api ? { api } : {})} />
    </div>
  );
}
