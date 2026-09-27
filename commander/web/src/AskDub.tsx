// "Dubに聞く" — a conversation-first Q&A over the dub-ecosystem codebase (read-only).
// Multi-session (sidebar), history persisted to D1 (survives restart), background runs
// (a run keeps streaming when you switch sessions/tabs), per-session drafts. The chat
// mechanics live in the shared ChatProvider (lib/chatStore) + ChatUI; this file only
// builds the Q&A prompt and lays out the console.
import { useCallback } from "react";
import { ASK_RUN_ARGS, buildAskPrompt, buildTranscript, DUB_ECOSYSTEM_CWD } from "./lib/askDub.ts";
import { useChat } from "./lib/chatStore.tsx";
import { ChatComposer, MessageLog, SessionSidebar } from "./ChatUI.tsx";
import { t } from "./lib/theme.ts";

export function AskDub() {
  const chat = useChat();
  const sessionId = chat.activeId("ask");
  const messages = sessionId ? chat.messages(sessionId) : [];
  const busy = sessionId ? chat.isRunning(sessionId) : false;

  const send = useCallback(
    async (text: string) => {
      // Auto-create a session on the first send if none is active.
      let sid = chat.activeId("ask");
      if (!sid) {
        const s = await chat.create("ask");
        sid = s?.id ?? null;
      }
      if (!sid) return;
      const prior = chat.messages(sid).map((m) => ({ role: m.role, text: m.text }));
      const prompt = buildAskPrompt(text, buildTranscript(prior));
      void chat.run("ask", sid, {
        userText: text,
        prompt,
        opts: { cwd: DUB_ECOSYSTEM_CWD, args: ASK_RUN_ARGS },
      });
    },
    [chat],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <p style={{ margin: 0, fontSize: 13, color: t.textMuted }}>
        dub-ecosystem について会話ベースで答える Q&A（読み取り専用・調べすぎない）。 cwd:{" "}
        <code style={{ fontSize: 12 }}>{DUB_ECOSYSTEM_CWD}</code>
      </p>
      <div style={{ display: "flex", gap: t.space4, alignItems: "stretch" }}>
        <SessionSidebar kind="ask" />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: t.space4 }}>
          <MessageLog
            messages={messages}
            emptyState={
              <>
                <p style={{ marginBottom: t.space2 }}>Dub について気軽に聞いてみてください。</p>
                <p style={{ fontSize: 12 }}>例: 「LPページってどんなの?」「予約送信の仕組みは?」</p>
              </>
            }
          />
          <ChatComposer
            sessionId={sessionId ?? "none"}
            placeholder="〇〇はどうなってる? と聞く（Enterで送信 / Shift+Enterで改行）"
            disabled={busy}
            busy={busy}
            sendLabel="聞く"
            onSend={(text) => void send(text)}
          />
        </div>
      </div>
    </div>
  );
}
