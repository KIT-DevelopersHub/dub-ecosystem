// Floating compose window (bottom-right), Gmail-style: minimize / maximize / close,
// To rendered as removable chips with a Cc/Bcc toggle, subject and body, and a
// send button. Recipient entry uses the shared @dub/app-ui EmailAddressSelect
// (chips + autocomplete), fed the feature's parseRecipients and correspondent
// candidates from the store. On send it appends to the Sent folder optimistically and
// posts via sendMail.deliver(); a failure restores this window and shows 再試行.
//
// P1-2 follow-up: this — NOT ComposeScreen (/mail/compose, a standalone route kept
// only for deep-links) — is the compose surface a real user actually reaches (the
// "メール" launcher tile renders GmailApp, whose own compose affordance is this
// floating window). The original P1-2 commit wired the leave-guard into
// ComposeScreen only, leaving this orphaned exactly like RoleEditorPage vs
// RolePermissionsEditor (see RolePermissionsEditor.tsx) — reload/tab-close and
// in-app navigation both silently dropped an in-progress message with no warning.
// Same @dub/app-ui draft-autosave/leave-guard pattern, keyed per compose.id so
// multiple simultaneous windows never collide; GmailApp.tsx's
// useRestoreComposeDraftsOnMount() re-opens any leftover draft found in storage
// on mount so a restored window is reachable to show the notice/beforeunload
// guard again.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { ConfirmDialog } from "@dub/ui";
import type { mail } from "@dub/types";
import { EmailAddressSelect, type EmailToken, DraftRestoredNotice, useDraftAutosave } from "@dub/app-ui";
import { newIdempotencyKey, parseRecipients } from "../mailApi.tsx";
import { AttachmentErrors, AttachmentTray } from "../AttachmentTray.tsx";
import { AttachmentPreview } from "../AttachmentPreview.tsx";
import { useComposeAttachments } from "../useComposeAttachments.tsx";
import { useMailApi } from "../MailProvider.tsx";
import { UnsavedChangesGuard } from "../../../lib/UnsavedChangesGuard.tsx";
import { MailIcon } from "./icons.tsx";
import { recipientIcon } from "./SenderAvatar.tsx";
import { addressCandidates } from "./mailModel.ts";
import { uid, useMailStore, type ComposeState } from "./useMailStore.tsx";
import { deliver } from "./sendMail.ts";
import { SchedulePicker } from "./SchedulePicker.tsx";
import { useServerDraft } from "./useServerDraft.ts";
import { useDraggableWindow, useIsNarrowViewport } from "./useDraggableWindow.ts";

/** localStorage key prefix for a floating compose window's draft — one per compose.id
 *  (several windows can be open at once, Gmail-style). Exported so GmailApp can scan
 *  for leftover drafts on mount and re-open a window for each. */
export const COMPOSE_WINDOW_DRAFT_PREFIX = "fe2.mail.compose.window.";
export function composeWindowDraftKey(id: string): string {
  return `${COMPOSE_WINDOW_DRAFT_PREFIX}${id}`;
}

/** Decode a stored base64 attachment back into a File for the tray. */
function inputToFile(input: mail.MailAttachmentInput): File {
  const bytes = Uint8Array.from(atob(input.contentBase64), (c) => c.charCodeAt(0));
  return new File([bytes], input.filename, { type: input.contentType });
}

interface ComposeWindowDraft {
  to: string;
  cc: string;
  bcc: string;
  showCc: boolean;
  showBcc: boolean;
  subject: string;
  body: string;
  mode?: ComposeState["mode"];
  inReplyTo?: string;
}

export function ComposeWindow({ compose, offset }: { compose: ComposeState; offset: number }): JSX.Element {
  const { state, dispatch } = useMailStore();
  const mailApi = useMailApi();

  // Address-book candidates: everyone the user has corresponded with (excluding self).
  const candidates: EmailToken[] = useMemo(() => addressCandidates(state.threads, state.me.email), [state.threads, state.me.email]);

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
  const submitted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  // Files arriving from a forward's original or a reopened draft: send waits for them.
  const [seeding, setSeeding] = useState(Boolean(compose.seed));
  const seedCount = useRef(0);
  const { addFiles, addError } = att;
  useEffect(() => {
    let alive = true;
    const { seed, seedInputs } = compose;
    if (seedInputs && seedInputs.length > 0) {
      const files = seedInputs.map((s) => ({ file: inputToFile(s.input), remoteId: s.remoteId }));
      seedCount.current += files.length;
      addFiles(files.map((f) => f.file), new Map(files.flatMap((f) => (f.remoteId ? [[f.file, f.remoteId] as const] : []))));
    }
    if (seed) {
      void Promise.all(
        seed.attachments.map(async (a) => {
          const blob = await mailApi.downloadAttachment(seed.source, seed.messageId, a.id);
          return { file: new File([blob], a.filename, { type: a.contentType }), remoteId: a.id };
        }),
      )
        .then((files) => {
          if (!alive) return;
          seedCount.current += files.length;
          // Only a draft's own files are already on it; a forward's belong to the original.
          addFiles(files.map((f) => f.file), seed.source === "drafts" ? new Map(files.map((f) => [f.file, f.remoteId])) : undefined);
        })
        .catch(() => alive && addError("添付ファイルを読み込めませんでした。もう一度添付してください。"))
        .finally(() => alive && setSeeding(false));
    }
    return () => {
      alive = false;
    };
    // Once per window: the seed describes how it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dirty = there is text worth keeping/warning about (matches ComposeScreen's rule;
  // attachments alone still warn on leave since they'd otherwise vanish silently).
  const draftKey = composeWindowDraftKey(compose.id);
  const dirty =
    compose.to.trim() !== "" ||
    compose.cc.trim() !== "" ||
    compose.bcc.trim() !== "" ||
    compose.subject.trim() !== "" ||
    compose.body.trim() !== "" ||
    att.items.length > 0;
  const draft = useDraftAutosave<ComposeWindowDraft>({
    storageKey: draftKey,
    value: {
      to: compose.to,
      cc: compose.cc,
      bcc: compose.bcc,
      showCc: compose.showCc,
      showBcc: compose.showBcc,
      subject: compose.subject,
      body: compose.body,
      mode: compose.mode,
      ...(compose.inReplyTo ? { inReplyTo: compose.inReplyTo } : {}),
    },
    dirty,
  });

  // Server copy (下書き folder). A reply/forward opens prefilled, so only a change from how the
  // window opened makes it worth keeping; emptying it again removes the draft (Gmail).
  const serverFields: mail.MailDraftInput = {
    mode: compose.mode,
    to: compose.to,
    cc: compose.cc,
    bcc: compose.bcc,
    subject: compose.subject,
    body: compose.body,
    ...(compose.inReplyTo ? { inReplyTo: compose.inReplyTo } : {}),
  };
  const openedAs = useRef(JSON.stringify(serverFields));
  const changed = JSON.stringify(serverFields) !== openedAs.current || att.items.length !== seedCount.current;
  const keepable = dirty && (compose.persisted === true || compose.restored === true || changed);
  const server = useServerDraft({ id: compose.id, draft: serverFields, active: keepable, persisted: compose.persisted === true, att });

  // ✕ keeps the mail as a draft (Gmail); a failed save keeps the local copy so a reload
  // restores the window instead of losing the text.
  const closeAndSave = (): void => {
    // A file still being read can't be saved yet, and closing would lose it unnoticed.
    if (att.hasPending || seeding) {
      setError("添付ファイルを処理中です。完了してから閉じてください。");
      return;
    }
    dispatch({ type: "CLOSE_COMPOSE", id: compose.id });
    if (!keepable) {
      draft.clear();
      return;
    }
    void server.flush().then((ok) => {
      if (ok) draft.clear();
      else dispatch({ type: "BLOCK_NOTICE", notice: { status: "failed", text: "下書きを保存できませんでした" } });
    });
  };

  // 下書きを破棄 (the trash button): gone everywhere, so it never resurrects on a reload.
  const discard = (): void => {
    server.discard();
    draft.clear();
    dispatch({ type: "CLOSE_COMPOSE", id: compose.id });
  };

  /** Everything needed to reopen this compose if the send fails, files included. */
  const snapshot = (): ComposeState => {
    const { seed: _seed, ...rest } = compose;
    void _seed;
    const seedInputs = att.items.flatMap((it) => (it.input ? [{ input: it.input, ...(it.remoteId ? { remoteId: it.remoteId } : {}) }] : []));
    return { ...rest, persisted: server.isSaved(), restored: true, seedInputs };
  };

  /** Gmail refuses a send it can't address, and says why. */
  const recipientsOk = (): boolean => {
    const bad = [compose.to, compose.cc, compose.bcc].flatMap((v) => parseRecipients(v).invalid);
    if (bad.length > 0) {
      setError(`アドレス「${bad[0]}」は認識されませんでした。すべてのアドレスが正しいことを確認してください。`);
      return false;
    }
    if (parseRecipients(compose.to).recipients.length === 0) {
      setError("少なくとも 1 人の宛先を指定してください。");
      return false;
    }
    setError(null);
    return true;
  };

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
    // Don't drop a file that is still being read: wait for the read to finish (Gmail keeps
    // Send disabled until the upload settles). The button is disabled while hasPending.
    if (submitted.current || att.hasPending || seeding || !recipientsOk()) return;
    if (compose.subject.trim() === "" && compose.body.trim() === "") {
      setConfirmEmpty(true);
      return;
    }
    sendNow();
  };

  const sendNow = (): void => {
    // One send per window: a double click / repeated shortcut before the window closes
    // must not post the same mail twice.
    if (submitted.current) return;
    const to = parseRecipients(compose.to).recipients;
    const cc = parseRecipients(compose.cc).recipients;
    const bcc = parseRecipients(compose.bcc).recipients;
    const draftSettled = server.stop();
    draft.clear(); // restored from the PendingSend snapshot if the send fails
    // Optimistic: show it in Sent immediately; deliver() drops it again on failure.
    const threadId = uid("thread");
    dispatch({ type: "SEND", to, cc, bcc, subject: compose.subject, body: compose.body, threadId });
    const req: mail.SendMailRequest = { to, subject: compose.subject || "(件名なし)", textBody: compose.body };
    if (cc.length > 0) req.cc = cc;
    if (bcc.length > 0) req.bcc = bcc;
    // Reply/replyAll carry the parent Message-Id so the gateway stamps In-Reply-To/References.
    if (compose.inReplyTo) req.inReplyTo = compose.inReplyTo;
    const inputs = att.readyInputs();
    if (inputs.length > 0) req.attachments = inputs;
    submitted.current = true;
    const pendingCompose = snapshot();
    dispatch({ type: "CLOSE_COMPOSE", id: compose.id });
    void deliver(mailApi, dispatch, { kind: "send", req, compose: pendingCompose, threadId, idempotencyKey: newIdempotencyKey(), draftSettled });
  };

  // Park the compose for a future time (SchedulePicker validated it is in the future).
  // Works for new mail AND 返信/全員に返信 (inReplyTo keeps the thread), with Cc/Bcc and
  // attachments — the gateway parks the files in R2 and attaches them at delivery.
  const scheduleSend = (when: Date): string | null => {
    const to = parseRecipients(compose.to).recipients;
    const cc = parseRecipients(compose.cc).recipients;
    const bcc = parseRecipients(compose.bcc).recipients;
    if (to.length === 0) return "宛先を入力してください";
    if (att.hasPending || seeding) return "添付ファイルを処理中です…";
    const req: mail.ScheduleMailRequest = {
      to,
      subject: compose.subject || "(件名なし)",
      textBody: compose.body,
      scheduledAt: when.toISOString(),
    };
    if (cc.length > 0) req.cc = cc;
    if (bcc.length > 0) req.bcc = bcc;
    if (compose.inReplyTo) req.inReplyTo = compose.inReplyTo;
    const inputs = att.readyInputs();
    if (inputs.length > 0) req.attachments = inputs;
    const draftSettled = server.stop();
    draft.clear();
    const pendingCompose = snapshot();
    dispatch({ type: "CLOSE_COMPOSE", id: compose.id });
    void deliver(mailApi, dispatch, { kind: "schedule", req, compose: pendingCompose, draftSettled });
    return null;
  };

  const maximized = compose.maximized;
  const minimized = compose.minimized;

  // Drag the window by its header (desktop, normal size only). Minimized windows dock
  // to the bottom edge like Gmail and return to the dragged spot when expanded.
  const narrow = useIsNarrowViewport();
  const { pos, dragging, onHandlePointerDown } = useDraggableWindow({
    enabled: !maximized && !minimized && !narrow,
    size: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    offset,
  });

  const frame: CSSProperties = maximized
    ? { position: "fixed", inset: "48px", width: "auto", height: "auto", maxWidth: 900, margin: "0 auto" }
    : narrow
      ? { position: "fixed", left: 8, right: 8, bottom: 0, height: minimized ? 40 : `min(${WINDOW_HEIGHT}px, calc(100dvh - 64px))` }
      : pos
        ? { position: "fixed", left: pos.x, top: pos.y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
        : { position: "fixed", right: 16 + offset * 30, bottom: 0, width: WINDOW_WIDTH, height: minimized ? 40 : WINDOW_HEIGHT };
  const draggable = !maximized && !minimized && !narrow;

  return (
    <div
      data-testid="fe2-mail-compose-window"
      data-p12-mail-window-draft-fix="1"
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
        borderRadius: pos && draggable ? "var(--dub-radius-lg)" : "var(--dub-radius-lg) var(--dub-radius-lg) 0 0",
        boxShadow: "var(--dub-shadow-overlay)",
        zIndex: "var(--dub-zIndex-modal, 1300)",
        overflow: "hidden",
      }}
    >
      <UnsavedChangesGuard when={dirty} testId={`fe2-mail-compose-window-leave-confirm-${compose.id}`} />
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
        data-testid="fe2-mail-compose-header"
        data-draggable={draggable ? "true" : "false"}
        title={draggable ? "ドラッグして移動" : undefined}
        onPointerDown={onHandlePointerDown}
        onClick={() => minimized && patch({ minimized: false })}
        style={{
          touchAction: draggable ? "none" : undefined,
          userSelect: dragging ? "none" : undefined,
          display: "flex",
          alignItems: "center",
          height: 40,
          padding: "0 8px 0 16px",
          background: "var(--dub-color-text-primary)",
          color: "var(--dub-color-surface-base)",
          cursor: minimized ? "pointer" : draggable ? (dragging ? "grabbing" : "grab") : "default",
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
        <button type="button" data-testid="fe2-mail-compose-close" aria-label="保存して閉じる" title="保存して閉じる" onClick={(e) => { e.stopPropagation(); closeAndSave(); }} style={hdrBtn}>
          <MailIcon name="x" size={16} />
        </button>
      </div>

      {minimized ? null : (
        <>
          <DraftRestoredNotice
            visible={draft.restoredVisible}
            onDiscard={() => {
              draft.clear();
              patch({ to: "", cc: "", bcc: "", showCc: false, showBcc: false, subject: "", body: "" });
            }}
            onKeep={draft.acknowledgeRestored}
            testId="fe2-mail-compose-window-draft-notice"
          />
          <EmailAddressSelect
            variant="flush"
            label="To"
            value={compose.to}
            onChange={(v) => patch({ to: v })}
            parse={parseRecipients}
            candidates={candidates}
            removeIcon={removeIcon}
            renderTokenIcon={recipientIcon}
            testId="fe2-mail-compose-to"
            extra={
              <span style={{ display: "flex", gap: 8 }}>
                {!compose.showCc ? (
                  <button type="button" onClick={() => patch({ showCc: true })} style={ccBtn}>Cc</button>
                ) : null}
                {!compose.showBcc ? (
                  <button type="button" data-testid="fe2-mail-compose-bcc-toggle" onClick={() => patch({ showBcc: true })} style={ccBtn}>Bcc</button>
                ) : null}
              </span>
            }
          />
          {compose.showCc ? (
            <EmailAddressSelect variant="flush" label="Cc" value={compose.cc} onChange={(v) => patch({ cc: v })} parse={parseRecipients} candidates={candidates} removeIcon={removeIcon} renderTokenIcon={recipientIcon} testId="fe2-mail-compose-cc" />
          ) : null}
          {compose.showBcc ? (
            <EmailAddressSelect variant="flush" label="Bcc" value={compose.bcc} onChange={(v) => patch({ bcc: v })} parse={parseRecipients} candidates={candidates} removeIcon={removeIcon} renderTokenIcon={recipientIcon} testId="fe2-mail-compose-bcc" />
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
            style={{ flex: 1, padding: 12, border: "none", outline: "none", resize: "none", background: "transparent", color: "var(--dub-color-text-primary)", fontSize: "var(--dub-font-size-md)", lineHeight: 1.6, fontFamily: "inherit" }}
          />
          {error ? (
            <div role="alert" data-testid="fe2-mail-compose-error" style={{ padding: "8px 12px", borderTop: "1px solid var(--dub-color-border-default)", fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-danger-600)", flexShrink: 0 }}>
              {error}
            </div>
          ) : null}
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
              disabled={att.hasPending || seeding}
              title={att.hasPending || seeding ? "添付ファイルを処理中です…" : undefined}
              style={{ all: "unset", cursor: att.hasPending || seeding ? "not-allowed" : "pointer", opacity: att.hasPending || seeding ? 0.6 : 1, display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 24px", borderRadius: "var(--dub-radius-full)", background: "var(--dub-color-brand-500)", color: "#fff", fontWeight: 600, fontSize: "var(--dub-font-size-sm)" }}
            >
              送信 <MailIcon name="send" size={16} />
            </button>
            <SchedulePicker
              testIdPrefix="fe2-mail-compose-schedule"
              onSchedule={scheduleSend}
              disabled={att.hasPending || seeding}
              disabledReason="添付ファイルを処理中です…"
              {...(att.items.length > 0 ? { hint: `添付ファイル ${att.items.length} 件も一緒に予約されます` } : {})}
            />
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
            <span data-testid="fe2-mail-compose-save-status" role="status" style={{ fontSize: "var(--dub-font-size-xs)", color: server.status === "failed" ? "var(--dub-color-danger-600)" : "var(--dub-color-text-muted)" }}>
              {server.status === "saving" ? "保存中…" : server.status === "saved" ? "下書きを保存しました" : server.status === "failed" ? "保存できませんでした" : null}
            </span>
            <button type="button" aria-label="下書きを破棄" data-testid="fe2-mail-compose-discard" onClick={discard} style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-text-muted)", padding: 6 }}>
              <MailIcon name="trash" size={18} />
            </button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmEmpty}
        title="件名と本文がありません"
        message="このメールを件名と本文なしで送信しますか？"
        confirmLabel="送信"
        onConfirm={() => {
          setConfirmEmpty(false);
          sendNow();
        }}
        onCancel={() => setConfirmEmpty(false)}
        testId="fe2-mail-compose-empty-confirm"
      />
    </div>
  );
}

const WINDOW_WIDTH = 500;
const WINDOW_HEIGHT = 460;
const hdrBtn: CSSProperties = { all: "unset", cursor: "pointer", display: "inline-flex", padding: 6, color: "var(--dub-color-surface-base)", opacity: 0.85 };
const ccBtn: CSSProperties = { all: "unset", cursor: "pointer", fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)", fontWeight: 600 };
