import { useState } from "react";
import { Board } from "./Board.tsx";
import { AskDub } from "./AskDub.tsx";
import type { CommanderClient } from "./lib/client.ts";
import type { CommanderApi } from "./lib/commanderApi.ts";
import { btnGhost, t } from "./lib/theme.ts";

interface AppProps {
  /** Exec-bridge client (commander-daemon). Omit to use the default HTTP client. */
  client?: CommanderClient;
  /** Phase-gate + board API (commander-service). Omit to use the default HTTP client. */
  api?: CommanderApi;
  /** Initial tab (tests). */
  initialTab?: TabId;
}

type TabId = "board" | "ask";

const TABS: { id: TabId; label: string }[] = [
  { id: "board", label: "ボード" },
  { id: "ask", label: "Dubに聞く" },
];

/** Standalone Commander page (commander/web dev/build). Two views share the chrome:
 *  「ボード」= 投入(composer) → 走行(lanes) → 確認/判断(drawer) → close (作らせる);
 *  「Dubに聞く」= dub-ecosystem コードベースへの読み取り専用 Q&A チャット (聞く). Inside Dub
 *  the same Board is embedded by apps/fe2-app-shell/src/features/commander without this chrome. */
export function App({ client, api, initialTab = "board" }: AppProps) {
  const [tab, setTab] = useState<TabId>(initialTab);
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
        {tab === "board"
          ? "ローカル Claude Code を Web から並行駆動する司令ボード — 投入・走行・確認・判断を1画面で"
          : "dub-ecosystem のコードを Claude Code に聞ける Q&A チャット — 読み取り専用"}
      </p>

      <nav style={{ display: "flex", gap: t.space2, marginBottom: t.space5 }} role="tablist">
        {TABS.map((tb) => {
          const active = tab === tb.id;
          return (
            <button
              key={tb.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`tab-${tb.id}`}
              onClick={() => setTab(tb.id)}
              style={{
                ...btnGhost,
                borderColor: active ? t.primary : t.border,
                color: active ? t.text : t.textMuted,
                background: active ? t.overlay : "transparent",
                fontWeight: active ? 600 : 400,
              }}
            >
              {tb.label}
            </button>
          );
        })}
      </nav>

      {tab === "board" ? (
        <Board {...(client ? { client } : {})} {...(api ? { api } : {})} />
      ) : (
        <AskDub {...(client ? { client } : {})} />
      )}
    </div>
  );
}
