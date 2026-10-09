import { useState } from "react";
import { Board } from "./Board.tsx";
import { AskDub } from "./AskDub.tsx";
import { OperateDub } from "./OperateDub.tsx";
import { ChatProvider } from "./lib/chatStore.tsx";
import type { CommanderClient } from "./lib/client.ts";
import type { CommanderApi } from "./lib/commanderApi.ts";
import { t } from "./lib/theme.ts";

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
      {/* GitHub Project のビュータブ同様、下線で選択中を示す */}
      <nav
        style={{ display: "flex", gap: t.space1, borderBottom: `1px solid ${t.border}`, marginBottom: t.space3 }}
        role="tablist"
      >
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
                background: "transparent",
                border: 0,
                borderBottom: `2px solid ${active ? t.primary : "transparent"}`,
                marginBottom: -1,
                padding: `${t.space2} ${t.space3}`,
                font: "inherit",
                fontSize: 14,
                fontWeight: active ? 600 : 400,
                color: active ? t.text : t.textMuted,
                cursor: "pointer",
              }}
            >
              {tb.label}
            </button>
          );
        })}
      </nav>
      <p style={{ color: t.textMuted, marginTop: 0, marginBottom: t.space4, fontSize: 13 }}>
        {TAB_SUBTITLE[tab]}
      </p>

      {/* Keep the chat tabs MOUNTED across tab switches (hidden, not unmounted) so their
          live message view + composer draft persist without a reload. */}
      <div hidden={tab !== "board"} data-testid="panel-board">
        <Board {...(client ? { client } : {})} {...(api ? { api } : {})} />
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
