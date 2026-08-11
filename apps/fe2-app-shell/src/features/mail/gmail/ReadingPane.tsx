// Reading pane: the opened conversation. Older messages collapse to a one-line
// summary (Gmail behaviour); the newest stays expanded. Header carries the
// subject, star and archive/delete actions; each message shows a round initial
// avatar, participants and full body. Reply / reply-all / forward open a prefilled
// floating compose; a trailing inline reply box appends to the thread in place.
import { useState, type CSSProperties } from "react";
import type { mail } from "@dub/types";
import {
  avatarColor,
  displayName,
  fullDate,
  initial,
  snippet,
  threadUnread,
  type Label,
  type MailMsg,
  type MailPerson,
  type MailThreadModel,
} from "./mailModel.ts";
import { MailIcon } from "./icons.tsx";
import { useMailStore } from "./useMailStore.tsx";
import { useMailApi } from "../MailProvider.tsx";

function fmtList(people: MailPerson[]): string {
  return people.map(displayName).join(", ");
}

function Avatar({ p, size = 36 }: { p: MailPerson; size?: number }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "var(--dub-radius-full)",
        background: avatarColor(p),
        color: "#fff",
        fontSize: size * 0.42,
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {initial(p)}
    </span>
  );
}

function quote(msg: MailMsg): string {
  const when = fullDate(msg.date);
  const who = displayName(msg.from);
  const quoted = msg.body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `\n\n${when} ${who} <${msg.from.email}>:\n${quoted}`;
}

function MessageBlock({ msg, defaultOpen }: { msg: MailMsg; defaultOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      data-testid="fe2-mail-thread-message"
      style={{ borderTop: "1px solid var(--dub-color-border-default)", padding: "16px 24px" }}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}
      >
        <Avatar p={msg.from} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <strong style={{ fontSize: "var(--dub-font-size-sm)" }}>{displayName(msg.from)}</strong>
            {open ? (
              <span style={{ fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)" }}>
                &lt;{msg.from.email}&gt;
              </span>
            ) : null}
          </div>
          {open ? (
            <div style={{ fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)" }}>
              宛先: {fmtList(msg.to)}
              {msg.cc && msg.cc.length > 0 ? ` ・ Cc: ${fmtList(msg.cc)}` : ""}
            </div>
          ) : (
            <div
              style={{
                fontSize: "var(--dub-font-size-sm)",
                color: "var(--dub-color-text-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {snippet(msg.body, 120)}
            </div>
          )}
        </div>
        <span style={{ fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)", flexShrink: 0 }}>
          {fullDate(msg.date)}
        </span>
      </div>
      {open ? (
        <div
          data-testid="fe2-mail-body-text"
          style={{
            marginTop: 16,
            marginLeft: 48,
            fontSize: "var(--dub-font-size-sm)",
            lineHeight: 1.6,
            color: "var(--dub-color-text-primary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {msg.body}
        </div>
      ) : null}
    </div>
  );
}

function HeaderButton({ label, icon, onClick, testId }: { label: string; icon: Parameters<typeof MailIcon>[0]["name"]; onClick: () => void; testId?: string }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...(testId ? { "data-testid": testId } : {})}
      onClick={onClick}
      style={{ all: "unset", cursor: "pointer", padding: 6, borderRadius: "var(--dub-radius-full)", color: "var(--dub-color-text-secondary)" }}
    >
      <MailIcon name={icon} size={20} />
    </button>
  );
}

export function ReadingPane({ thread, labels }: { thread: MailThreadModel; labels: Label[] }): JSX.Element {
  const { dispatch, state } = useMailStore();
  const mailApi = useMailApi();
  const [reply, setReply] = useState("");
  const lastIdx = thread.messages.length - 1;
  const last = thread.messages[lastIdx]!;
  const chips = thread.labels.map((id) => labels.find((l) => l.id === id)).filter((l): l is Label => Boolean(l));

  const replyRecipients = last.from.email === state.me.email ? last.to : [last.from];
  const allRecipients = [
    ...(last.from.email === state.me.email ? last.to : [last.from]),
    ...last.to.filter((t) => t.email !== state.me.email),
    ...(last.cc ?? []),
  ];

  const openCompose = (mode: "reply" | "replyAll" | "forward"): void => {
    const to = mode === "forward" ? [] : mode === "replyAll" ? allRecipients : replyRecipients;
    dispatch({
      type: "OPEN_COMPOSE",
      compose: {
        mode,
        to: to.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", "),
        subject: `${mode === "forward" ? "Fwd" : "Re"}: ${thread.subject.replace(/^(Re|Fwd):\s*/i, "")}`,
        body: quote(last),
        showCc: mode === "replyAll",
        // Reply/replyAll thread against the parent's Message-Id; a forward is a new message.
        ...(mode !== "forward" && last.messageId ? { inReplyTo: last.messageId } : {}),
      },
    });
  };

  const sendInline = (): void => {
    const body = reply.trim();
    if (body.length === 0 || replyRecipients.length === 0) return;
    // Optimistic: append to the open thread immediately. Previously this was ALL that
    // happened — the reply never reached the gateway, so nothing was delivered. Now we
    // also POST it (with In-Reply-To via the parent Message-Id) and re-sync so the sent
    // reply is server-backed and survives a reload.
    dispatch({ type: "ADD_MESSAGE", threadId: thread.id, body, to: replyRecipients, subject: thread.subject });
    setReply("");
    const req: mail.SendMailRequest = {
      to: replyRecipients,
      subject: /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`,
      textBody: body,
    };
    if (last.messageId) req.inReplyTo = last.messageId;
    void mailApi
      .send(req)
      .then(() => dispatch({ type: "REQUEST_SYNC" }))
      .catch(() => undefined);
  };

  return (
    <section
      data-testid="fe2-mail-thread"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--dub-color-surface-base)",
        border: "1px solid var(--dub-color-border-default)",
        borderRadius: "var(--dub-radius-lg)",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 44, padding: "0 12px", borderBottom: "1px solid var(--dub-color-border-default)" }}>
        <HeaderButton label="一覧に戻る" icon="reply" onClick={() => dispatch({ type: "CLOSE_THREAD" })} testId="fe2-mail-thread-back" />
        <div style={{ width: 1, height: 20, background: "var(--dub-color-border-default)" }} />
        <HeaderButton label="アーカイブ" icon="archive" onClick={() => dispatch({ type: "ARCHIVE", ids: [thread.id] })} />
        <HeaderButton label="削除" icon="trash" onClick={() => dispatch({ type: "TRASH", ids: [thread.id] })} />
        <HeaderButton
          label={threadUnread(thread) ? "既読にする" : "未読にする"}
          icon="mail-open"
          onClick={() => dispatch({ type: "SET_READ", ids: [thread.id], read: threadUnread(thread) })}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ padding: "20px 24px 4px", display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: "var(--dub-font-size-xl)", fontWeight: 500, color: "var(--dub-color-text-primary)", flex: 1 }}>
            {thread.subject || "(件名なし)"}
          </h1>
          <button
            type="button"
            aria-label={thread.starred ? "スターを外す" : "スターを付ける"}
            onClick={() => dispatch({ type: "TOGGLE_STAR", id: thread.id })}
            style={{ all: "unset", cursor: "pointer", padding: 4 }}
          >
            <MailIcon name={thread.starred ? "star-filled" : "star"} size={20} style={{ color: thread.starred ? "#f4b400" : "var(--dub-color-text-muted)" }} />
          </button>
        </div>
        {chips.length > 0 ? (
          <div style={{ padding: "0 24px 8px", display: "flex", gap: 6 }}>
            {chips.map((l) => (
              <span
                key={l.id}
                style={{ fontSize: 11, padding: "1px 8px", borderRadius: "var(--dub-radius-full)", border: `1px solid ${l.color}`, color: "var(--dub-color-text-secondary)" }}
              >
                {l.name}
              </span>
            ))}
          </div>
        ) : null}

        {thread.messages.map((m, i) => (
          <MessageBlock key={m.id} msg={m} defaultOpen={i === lastIdx} />
        ))}

        <div style={{ borderTop: "1px solid var(--dub-color-border-default)", padding: "16px 24px", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" data-testid="fe2-mail-reply" onClick={() => openCompose("reply")} style={actionBtn}>
            <MailIcon name="reply" size={16} /> 返信
          </button>
          <button type="button" data-testid="fe2-mail-reply-all" onClick={() => openCompose("replyAll")} style={actionBtn}>
            <MailIcon name="reply-all" size={16} /> 全員に返信
          </button>
          <button type="button" data-testid="fe2-mail-forward" onClick={() => openCompose("forward")} style={actionBtn}>
            <MailIcon name="forward" size={16} /> 転送
          </button>
        </div>

        <div style={{ padding: "0 24px 24px" }}>
          <div style={{ display: "flex", gap: 12, border: "1px solid var(--dub-color-border-strong)", borderRadius: "var(--dub-radius-lg)", padding: 12 }}>
            <Avatar p={state.me} size={32} />
            <div style={{ flex: 1 }}>
              <textarea
                data-testid="fe2-mail-inline-reply"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={`${displayName(replyRecipients[0] ?? state.me)} に返信…`}
                rows={reply ? 4 : 1}
                style={{
                  width: "100%",
                  resize: "vertical",
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  color: "var(--dub-color-text-primary)",
                  fontSize: "var(--dub-font-size-sm)",
                  fontFamily: "inherit",
                }}
              />
              {reply ? (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    data-testid="fe2-mail-inline-send"
                    onClick={sendInline}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      padding: "8px 20px",
                      borderRadius: "var(--dub-radius-full)",
                      background: "var(--dub-color-brand-500)",
                      color: "#fff",
                      fontWeight: 600,
                      fontSize: "var(--dub-font-size-sm)",
                    }}
                  >
                    送信
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const actionBtn: CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 16px",
  borderRadius: "var(--dub-radius-full)",
  border: "1px solid var(--dub-color-border-strong)",
  color: "var(--dub-color-text-secondary)",
  fontSize: "var(--dub-font-size-sm)",
  fontWeight: 500,
};
