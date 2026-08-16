// Floating compose window (bottom-right), Gmail-style: minimize / maximize / close,
// To rendered as removable chips with a Cc/Bcc toggle, subject and body, and a
// send button. Recipient entry uses the shared @dub/app-ui EmailAddressSelect
// (chips + autocomplete), fed the feature's parseRecipients and correspondent
// candidates from the store. On send it appends to the Sent folder via the store
// and best-effort posts through the real MailApi (ignored under the demo mock).
import { useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { mail } from "@dub/types";
import { EmailAddressSelect, type EmailToken } from "@dub/app-ui";
import { parseRecipients } from "../mailApi.tsx";
import { AttachmentErrors, AttachmentTray } from "../AttachmentTray.tsx";
import { AttachmentPreview } from "../AttachmentPreview.tsx";
import { useComposeAttachments } from "../useComposeAttachments.tsx";
import { useMailApi } from "../MailProvider.tsx";
import { MailIcon } from "./icons.tsx";
import { useMailStore, type ComposeState } from "./useMailStore.tsx";

export function ComposeWindow({ compose, offset }: { compose: ComposeState; offset: number }): JSX.Element {
  const { state, dispatch } = useMailStore();
  const mailApi = useMailApi();

  // Address-book candidates: everyone the user has corresponded with (excluding self).
  const candidates: EmailToken[] = useMemo(() => {
    const byEmail = new Map<string, EmailToken>();
    for (const t of state.threads) {
      for (const m of t.messages) {
        for (const p of [m.from, ...m.to, ...(m.cc ?? [])]) {
          if (p.email && p.email !== state.me.email && !byEmail.has(p.email)) {
            byEmail.set(p.email, p.name ? { email: p.email, name: p.name } : { email: p.email });
          }
        }
      }
    }
    return [...byEmail.values()];
  }, [state.threads, state.me.email]);

  const removeIcon = <MailIcon name="x" size={12} />;
  const patch = (p: Partial<ComposeState>): void => dispatch({ type: "UPDATE_COMPOSE", id: compose.id, patch: p });

  // Attachments live in the shared compose-attachment hook (Gmail parity): clip-pick OR
  // drag-and-drop, forbidden-type/size/count rules with explicit errors, per-file read
  // progress and image thumbnails. `readyInputs()` rides the SendMailRequest; the gateway
  // persists the bytes to R2 and hands the provider the structured attachment list.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const att = useComposeAttachments();
  const [dragOver, setDragOver] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const dragDepth = useRef(0);

  const onDragEnter = (e: DragEvent): void => {
    if (minimized || !Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: DragEvent): void => {
    if (minimized || !Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: DragEvent): void => {
    if (minimized) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    att.addFiles(e.dataTransfer?.files ?? null);
  };

  const send = (): void => {
    const to = parseRecipients(compose.to).recipients;
    const cc = parseRecipients(compose.cc).recipients;
    if (to.length === 0) return;
    // Don't drop a file that is still being read: wait for the read to finish (Gmail keeps
    // Send disabled until the upload settles). The button is disabled while hasPending.
    if (att.hasPending) return;
    // Optimistic: show it in Sent immediately. The real send follows; once the gateway
    // confirms, REQUEST_SYNC re-fetches GET /mail/sent so the entry is server-backed and
    // survives a reload (the From is the gateway-resolved <user>@developershub.jp).
    dispatch({ type: "SEND", to, cc, subject: compose.subject, body: compose.body });
    const req: mail.SendMailRequest = { to, subject: compose.subject || "(件名なし)", textBody: compose.body };
    if (cc.length > 0) req.cc = cc;
    // Reply/replyAll carry the parent Message-Id so the gateway stamps In-Reply-To/
    // References (recipient threads the conversation; a further reply chains back to us).
    if (compose.inReplyTo) req.inReplyTo = compose.inReplyTo;
    const inputs = att.readyInputs();
    if (inputs.length > 0) req.attachments = inputs;
    void mailApi
      .send(req)
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
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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
      {dragOver && !minimized ? (
        <div
          data-testid="fe2-mail-compose-dropzone"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            background: "var(--dub-color-brand-50, rgba(59,130,246,0.10))",
            border: "2px dashed var(--dub-color-brand-500)",
            borderRadius: "inherit",
            color: "var(--dub-color-brand-600, var(--dub-color-brand-500))",
            fontSize: "var(--dub-font-size-sm)",
            fontWeight: 600,
            pointerEvents: "none",
          }}
        >
          <MailIcon name="paperclip" size={20} />
          ここにドロップして添付
        </div>
      ) : null}
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
          <EmailAddressSelect
            variant="flush"
            label="To"
            value={compose.to}
            onChange={(v) => patch({ to: v })}
            parse={parseRecipients}
            candidates={candidates}
            removeIcon={removeIcon}
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
          {compose.showCc ? (
            <EmailAddressSelect variant="flush" label="Cc" value={compose.cc} onChange={(v) => patch({ cc: v })} parse={parseRecipients} candidates={candidates} removeIcon={removeIcon} testId="fe2-mail-compose-cc" />
          ) : null}
          {compose.showBcc ? (
            <EmailAddressSelect variant="flush" label="Bcc" value={compose.bcc} onChange={(v) => patch({ bcc: v })} parse={parseRecipients} candidates={candidates} removeIcon={removeIcon} testId="fe2-mail-compose-bcc" />
          ) : null}
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
          {att.errors.length > 0 || att.items.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--dub-color-border-default)", maxHeight: 160, overflowY: "auto", flexShrink: 0 }}>
              <AttachmentErrors errors={att.errors} onDismiss={att.dismissErrors} />
              <AttachmentTray items={att.items} onRemove={att.remove} onOpen={setPreviewId} />
            </div>
          ) : null}
          <AttachmentPreview items={att.items} openId={previewId} onClose={() => setPreviewId(null)} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 56, padding: "0 12px", borderTop: "1px solid var(--dub-color-border-default)", flexShrink: 0 }}>
            <button
              type="button"
              data-testid="fe2-mail-compose-send"
              onClick={send}
              disabled={att.hasPending}
              title={att.hasPending ? "添付ファイルを処理中です…" : undefined}
              style={{ all: "unset", cursor: att.hasPending ? "not-allowed" : "pointer", opacity: att.hasPending ? 0.6 : 1, display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 24px", borderRadius: "var(--dub-radius-full)", background: "var(--dub-color-brand-500)", color: "#fff", fontWeight: 600, fontSize: "var(--dub-font-size-sm)" }}
            >
              送信 <MailIcon name="send" size={16} />
            </button>
            <button
              type="button"
              aria-label="ファイルを添付"
              data-testid="fe2-mail-compose-attach"
              onClick={() => fileInputRef.current?.click()}
              style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-text-muted)", padding: 6 }}
            >
              <MailIcon name="paperclip" size={18} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              data-testid="fe2-mail-compose-attach-input"
              onChange={(e) => {
                att.addFiles(e.target.files);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              style={{ display: "none" }}
            />
            {att.items.length > 0 ? (
              <span data-testid="fe2-mail-compose-attach-count" style={{ fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)" }}>
                {att.items.length} 件
              </span>
            ) : null}
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
