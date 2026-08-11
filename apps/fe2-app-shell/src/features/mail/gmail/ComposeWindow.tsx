// Floating compose window (bottom-right), Gmail-style: minimize / maximize / close,
// To rendered as removable chips with a Cc/Bcc toggle, subject and body, and a
// send button. Recipients are parsed with the feature's shared parseRecipients.
// On send it appends to the Sent folder via the store and best-effort posts through
// the real MailApi (ignored under the demo mock).
import { useState, type CSSProperties } from "react";
import type { mail } from "@dub/types";
import { parseRecipients } from "../mailApi.tsx";
import { useMailApi } from "../MailProvider.tsx";
import { MailIcon } from "./icons.tsx";
import { useMailStore, type ComposeState } from "./useMailStore.tsx";

function Chips({ raw, onRemove }: { raw: string; onRemove: (email: string) => void }): JSX.Element | null {
  const { recipients } = parseRecipients(raw);
  if (recipients.length === 0) return null;
  return (
    <>
      {recipients.map((r) => (
        <span
          key={r.email}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 4px 2px 8px",
            borderRadius: "var(--dub-radius-full)",
            background: "var(--dub-color-surface-sunken)",
            border: "1px solid var(--dub-color-border-default)",
            fontSize: "var(--dub-font-size-xs)",
            color: "var(--dub-color-text-primary)",
          }}
        >
          {r.name ?? r.email}
          <button
            type="button"
            aria-label={`${r.email} を削除`}
            onClick={() => onRemove(r.email)}
            style={{ all: "unset", cursor: "pointer", display: "inline-flex", color: "var(--dub-color-text-muted)" }}
          >
            <MailIcon name="x" size={12} />
          </button>
        </span>
      ))}
    </>
  );
}

function RecipientField({
  label,
  value,
  onChange,
  testId,
  extra,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
  extra?: JSX.Element;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const commit = (): void => {
    const t = draft.trim().replace(/[,;]$/, "");
    if (t.length > 0) onChange(value ? `${value}, ${t}` : t);
    setDraft("");
  };
  const removeChip = (email: string): void => {
    const { recipients } = parseRecipients(value);
    onChange(recipients.filter((r) => r.email !== email).map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(", "));
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 36, padding: "4px 12px", borderBottom: "1px solid var(--dub-color-border-default)", flexWrap: "wrap" }}>
      <span style={{ fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)", width: 28 }}>{label}</span>
      <Chips raw={value} onRemove={removeChip} />
      <input
        data-testid={testId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === ";") {
            e.preventDefault();
            commit();
          }
        }}
        style={{ flex: 1, minWidth: 80, border: "none", outline: "none", background: "transparent", color: "var(--dub-color-text-primary)", fontSize: "var(--dub-font-size-sm)", fontFamily: "inherit" }}
      />
      {extra}
    </div>
  );
}

export function ComposeWindow({ compose, offset }: { compose: ComposeState; offset: number }): JSX.Element {
  const { dispatch } = useMailStore();
  const mailApi = useMailApi();
  const patch = (p: Partial<ComposeState>): void => dispatch({ type: "UPDATE_COMPOSE", id: compose.id, patch: p });

  const send = (): void => {
    const to = parseRecipients(compose.to).recipients;
    const cc = parseRecipients(compose.cc).recipients;
    if (to.length === 0) return;
    // Optimistic: show it in Sent immediately. The real send follows; once the gateway
    // confirms, REQUEST_SYNC re-fetches GET /mail/sent so the entry is server-backed and
    // survives a reload (the From is the gateway-resolved <user>@developershub.jp).
    dispatch({ type: "SEND", to, cc, subject: compose.subject, body: compose.body });
    const req: mail.SendMailRequest = { to, subject: compose.subject || "(件名なし)", textBody: compose.body };
    void mailApi
      .send(cc.length > 0 ? { ...req, cc } : req)
      .then(() => dispatch({ type: "REQUEST_SYNC" }))
      .catch(() => undefined);
    dispatch({ type: "CLOSE_COMPOSE", id: compose.id });
  };

  const maximized = compose.maximized;
  const minimized = compose.minimized;

  const frame: CSSProperties = maximized
    ? { position: "fixed", inset: "48px", width: "auto", height: "auto", maxWidth: 900, margin: "0 auto" }
    : { position: "fixed", right: 16 + offset * 30, bottom: 0, width: 500, height: minimized ? 40 : 460 };

  return (
    <div
      data-testid="fe2-mail-compose-window"
      style={{
        ...frame,
        display: "flex",
        flexDirection: "column",
        background: "var(--dub-color-surface-raised)",
        border: "1px solid var(--dub-color-border-strong)",
        borderRadius: "var(--dub-radius-lg) var(--dub-radius-lg) 0 0",
        boxShadow: "var(--dub-shadow-overlay)",
        zIndex: 1300,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => minimized && patch({ minimized: false })}
        style={{
          display: "flex",
          alignItems: "center",
          height: 40,
          padding: "0 8px 0 16px",
          background: "var(--dub-color-text-primary)",
          color: "var(--dub-color-surface-base)",
          cursor: minimized ? "pointer" : "default",
          flexShrink: 0,
        }}
      >
        <span style={{ flex: 1, fontSize: "var(--dub-font-size-sm)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {compose.subject || "新規メッセージ"}
        </span>
        <button type="button" aria-label="最小化" onClick={(e) => { e.stopPropagation(); patch({ minimized: !minimized }); }} style={hdrBtn}>
          <MailIcon name="minus" size={16} />
        </button>
        <button type="button" aria-label={maximized ? "元のサイズに戻す" : "全画面表示"} onClick={(e) => { e.stopPropagation(); patch({ maximized: !maximized, minimized: false }); }} style={hdrBtn}>
          <MailIcon name="expand" size={16} />
        </button>
        <button type="button" data-testid="fe2-mail-compose-close" aria-label="閉じる" onClick={(e) => { e.stopPropagation(); dispatch({ type: "CLOSE_COMPOSE", id: compose.id }); }} style={hdrBtn}>
          <MailIcon name="x" size={16} />
        </button>
      </div>

      {minimized ? null : (
        <>
          <RecipientField
            label="To"
            value={compose.to}
            onChange={(v) => patch({ to: v })}
            testId="fe2-mail-compose-to"
            extra={
              <span style={{ display: "flex", gap: 8 }}>
                {!compose.showCc ? (
                  <button type="button" onClick={() => patch({ showCc: true })} style={ccBtn}>Cc</button>
                ) : null}
                {!compose.showBcc ? (
                  <button type="button" onClick={() => patch({ showBcc: true })} style={ccBtn}>Bcc</button>
                ) : null}
              </span>
            }
          />
          {compose.showCc ? <RecipientField label="Cc" value={compose.cc} onChange={(v) => patch({ cc: v })} testId="fe2-mail-compose-cc" /> : null}
          {compose.showBcc ? <RecipientField label="Bcc" value={compose.bcc} onChange={(v) => patch({ bcc: v })} testId="fe2-mail-compose-bcc" /> : null}
          <input
            data-testid="fe2-mail-compose-subject"
            value={compose.subject}
            onChange={(e) => patch({ subject: e.target.value })}
            placeholder="件名"
            style={{ height: 36, padding: "0 12px", border: "none", borderBottom: "1px solid var(--dub-color-border-default)", outline: "none", background: "transparent", color: "var(--dub-color-text-primary)", fontSize: "var(--dub-font-size-sm)", fontWeight: 600, fontFamily: "inherit" }}
          />
          <textarea
            data-testid="fe2-mail-compose-body"
            value={compose.body}
            onChange={(e) => patch({ body: e.target.value })}
            placeholder="本文を入力…"
            style={{ flex: 1, padding: 12, border: "none", outline: "none", resize: "none", background: "transparent", color: "var(--dub-color-text-primary)", fontSize: "var(--dub-font-size-sm)", lineHeight: 1.6, fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 56, padding: "0 12px", borderTop: "1px solid var(--dub-color-border-default)", flexShrink: 0 }}>
            <button
              type="button"
              data-testid="fe2-mail-compose-send"
              onClick={send}
              style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 24px", borderRadius: "var(--dub-radius-full)", background: "var(--dub-color-brand-500)", color: "#fff", fontWeight: 600, fontSize: "var(--dub-font-size-sm)" }}
            >
              送信 <MailIcon name="send" size={16} />
            </button>
            <button type="button" aria-label="ファイルを添付" style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-text-muted)", padding: 6 }}>
              <MailIcon name="paperclip" size={18} />
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" aria-label="下書きを破棄" onClick={() => dispatch({ type: "CLOSE_COMPOSE", id: compose.id })} style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-text-muted)", padding: 6 }}>
              <MailIcon name="trash" size={18} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const hdrBtn: CSSProperties = { all: "unset", cursor: "pointer", display: "inline-flex", padding: 6, color: "var(--dub-color-surface-base)", opacity: 0.85 };
const ccBtn: CSSProperties = { all: "unset", cursor: "pointer", fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)", fontWeight: 600 };
