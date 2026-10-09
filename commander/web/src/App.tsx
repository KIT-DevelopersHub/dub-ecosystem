import { useState } from "react";
import { Board } from "./Board.tsx";
import { AskDub } from "./AskDub.tsx";
import { OperateDub } from "./OperateDub.tsx";
import { ChatProvider } from "./lib/chatStore.tsx";
import type { CommanderClient } from "./lib/client.ts";
import type { CommanderApi } from "./lib/commanderApi.ts";
import { btnGhost, t } from "./lib/theme.ts";

export type CommanderTabId = "board" | "ask" | "operate";

interface WorkspaceProps {
  /** Exec-bridge client (commander-daemon). Omit to use the default HTTP client. */
  client?: CommanderClient;
  /** Phase-gate + board API (commander-service). Omit to use the default HTTP client. */
  api?: CommanderApi;
  /** Initial tab (tests). Ignored when `tab` is controlled. */
  initialTab?: CommanderTabId;
  /** Controlled tab (the standalone page needs it to size its container). */
  tab?: CommanderTabId;
  onTabChange?: (tab: CommanderTabId) => void;
  /** Board refresh interval. The relay passes a slower one: every poll wakes its Durable Object. */
  boardPollMs?: number;
}

const TABS: { id: CommanderTabId; label: string }[] = [
  { id: "board", label: "ボード" },
  { id: "ask", label: "Dubに聞く" },
  { id: "operate", label: "Dubを操作" },
];

const TAB_SUBTITLE: Record<CommanderTabId, string> = {
  board: "ローカル Claude Code を Web から並行駆動する司令ボード — 投入・走行・確認・判断を1画面で",
  ask: "dub-ecosystem のコードを Claude Code に聞ける Q&A チャット — 読み取り専用",
  operate: "Dub の本番バックエンドを自然言語で操作 — 計画→確認→実行（書き込みは要確認）",
};

/** The whole Commander body (tabs + ボード/Dubに聞く/Dubを操作) without page chrome. SoT for
 *  both the standalone page (App below) and the Dub app (apps/fe2-app-shell/src/features/
 *  commander), so the two always render the same thing. */
export function CommanderWorkspace({
  client,
  api,
  initialTab = "board",
  tab: controlledTab,
  onTabChange,
  boardPollMs,
}: WorkspaceProps) {
  const [ownTab, setOwnTab] = useState<CommanderTabId>(initialTab);
  const tab = controlledTab ?? ownTab;
  const select = (next: CommanderTabId) => {
    setOwnTab(next);
    onTabChange?.(next);
  };
  return (
    // ChatProvider wraps the WHOLE tree (not just the chat tabs) so a background run
    // started in "Dubに聞く"/"Dubを操作" keeps streaming while the operator is on the board.
    <ChatProvider {...(client ? { client } : {})} {...(api ? { api } : {})}>
      <p style={{ opacity: 0.7, marginTop: 0, fontSize: 13 }}>{TAB_SUBTITLE[tab]}</p>

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
              onClick={() => select(tb.id)}
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

      {/* Keep the chat tabs MOUNTED across tab switches (hidden, not unmounted) so their
          live message view + composer draft persist without a reload. */}
      <div hidden={tab !== "board"} data-testid="panel-board">
        <Board {...(client ? { client } : {})} {...(api ? { api } : {})} {...(boardPollMs ? { pollMs: boardPollMs } : {})} />
      </div>
      <div hidden={tab !== "ask"} data-testid="panel-ask">
        <AskDub />
      </div>
      <div hidden={tab !== "operate"} data-testid="panel-operate">
        <OperateDub />
      </div>
    </ChatProvider>
  );
}

type AppProps = Pick<WorkspaceProps, "client" | "api" | "initialTab">;

/** Standalone Commander page (commander/web dev/build): page chrome + CommanderWorkspace. */
export function App({ client, api, initialTab = "board" }: AppProps) {
  const [tab, setTab] = useState<CommanderTabId>(initialTab);
  return (
    <div
      style={{
        // ボードは 8 レーン + 広い完了列なので画面幅いっぱいまで使う。
        maxWidth: tab === "board" ? 1920 : 1200,
        margin: "0 auto",
        padding: 24,
        fontFamily: "var(--dub-font-family-sans, system-ui, sans-serif)",
        color: "var(--dub-color-text-primary, #e6e6e6)",
        background: "var(--dub-color-surface-base, #0f1115)",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Commander</h1>
      <CommanderWorkspace
        {...(client ? { client } : {})}
        {...(api ? { api } : {})}
        tab={tab}
        onTabChange={setTab}
      />
    </div>
  );
}
