// Reading pane: the opened conversation. Older messages collapse to a one-line
// summary (Gmail behaviour); the newest stays expanded. Header carries the
// subject, star and archive/delete actions; each message shows a round initial
// avatar, participants and full body. Reply / reply-all / forward open a prefilled
// floating compose; a trailing inline reply box appends to the thread in place.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { EmailAddressSelect } from "@dub/app-ui";
import { Badge, Button } from "@dub/ui";
import type { mail } from "@dub/types";
import { isImageType } from "../attach.ts";
import {
  addressCandidates,
  avatarColor,
  displayName,
  fullDate,
  initial,
  pendingReplyIds,
  replyAllRecipients,
  replyNudge,
  sharedRecipientLabel,
  snippet,
  threadMine,
  threadUnread,
  type Label,
  type MailMsg,
  type MailPerson,
  type MailThreadModel,
} from "./mailModel.ts";
import { MailIcon } from "./icons.tsx";
import { MessageDetailsDialog, ownAddresses, recipientSummary } from "./MessageDetails.tsx";
import { confirmPurge } from "./ThreadList.tsx";
import { uid, useMailStore } from "./useMailStore.tsx";
import styles from "./replyNudge.module.css";
import inlineStyles from "./InlineReply.module.css";
import { SchedulePicker } from "./SchedulePicker.tsx";
import { deliver } from "./sendMail.ts";
import { AttachmentErrors, AttachmentTray } from "../AttachmentTray.tsx";
import { AttachmentPreview } from "../AttachmentPreview.tsx";
import { useComposeAttachments } from "../useComposeAttachments.tsx";
import { useMailApi } from "../MailProvider.tsx";
import { formatBytes, parseRecipients, saveBlob } from "../mailApi.tsx";

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

/** Attachment strip inside an open message. A "stored" attachment downloads its R2 body
 *  via the session-authorized MailApi; a non-stored one (too large / message truncated,
 *  改善#2) shows as a disabled chip with the reason so the file is never silently dropped.
 *  kind picks the gateway route: our own sent message -> "sent", received -> "messages". */
/** Inline thumbnail for a STORED image attachment (Gmail shows images inline). Lazy-fetches
 *  the R2 bytes via the session-authorized MailApi on mount, renders the image, and clicking
 *  it downloads the original. Object URL revoked on unmount. Falls back silently if the fetch
 *  fails (the generic download chip below still covers it). */
function InlineImage({ msg, att, kind }: { msg: MailMsg; att: mail.MailAttachment; kind: "messages" | "sent" }): JSX.Element {
  const mailApi = useMailApi();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    void (async () => {
      try {
        const blob = await mailApi.downloadAttachment(kind, msg.id, att.id);
        if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
        url = URL.createObjectURL(blob);
        if (alive) setSrc(url);
        else URL.revokeObjectURL(url);
      } catch {
        /* fall back to the download chip */
      }
    })();
    return () => {
      alive = false;
      if (url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
    };
  }, [mailApi, msg.id, att.id, kind]);

  const save = async (): Promise<void> => {
    try {
      const blob = await mailApi.downloadAttachment(kind, msg.id, att.id);
      saveBlob(blob, att.filename);
    } catch {
      /* best-effort */
    }
  };
  return (
    <button
      type="button"
      data-testid="fe2-mail-attachment-image"
      aria-label={`${att.filename} をダウンロード`}
      title={att.filename}
      onClick={() => void save()}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        width: 200,
        borderRadius: "var(--dub-radius-md)",
        border: "1px solid var(--dub-color-border-default)",
        overflow: "hidden",
        background: "var(--dub-color-surface-sunken)",
      }}
    >
      <span style={{ height: 130, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {src ? (
          <img src={src} alt={att.filename} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <MailIcon name="image" size={28} style={{ color: "var(--dub-color-text-muted)" }} />
        )}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-secondary)" }}>
        <MailIcon name="download" size={14} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.filename}</span>
        <span style={{ color: "var(--dub-color-text-muted)", flexShrink: 0 }}>{formatBytes(att.sizeBytes)}</span>
      </span>
    </button>
  );
}

function Attachments({ msg }: { msg: MailMsg }): JSX.Element | null {
  const mailApi = useMailApi();
  const [busy, setBusy] = useState<string | null>(null);
  const list = msg.attachments ?? [];
  if (list.length === 0) return null;
  const kind: "messages" | "sent" = msg.outbound ? "sent" : "messages";
  const download = async (att: mail.MailAttachment): Promise<void> => {
    setBusy(att.id);
    try {
      const blob = await mailApi.downloadAttachment(kind, msg.id, att.id);
      saveBlob(blob, att.filename);
    } catch {
      /* best-effort: a failed download leaves the chip enabled for a retry */
    } finally {
      setBusy(null);
    }
  };
  return (
    <div
      data-testid="fe2-mail-attachments"
      style={{ marginTop: 16, marginLeft: 48, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}
    >
      {list.map((a) => {
        const dropped = a.status !== undefined && a.status !== "stored";
        const reason = a.status === "dropped_too_large" ? "サイズ超過のため保存されませんでした" : a.status === "dropped_truncated" ? "メール全体が大きすぎて取得できませんでした" : "";
        // Stored images render as an inline thumbnail (Gmail parity); everything else — and any
        // dropped attachment — stays a compact download/disabled chip.
        if (!dropped && isImageType(a.contentType)) {
          return <InlineImage key={a.id} msg={msg} att={a} kind={kind} />;
        }
        return (
          <button
            key={a.id}
            type="button"
            data-testid="fe2-mail-attachment"
            disabled={dropped || busy === a.id}
            aria-label={dropped ? `${a.filename}（${reason}）` : `${a.filename} をダウンロード`}
            title={dropped ? reason : a.filename}
            onClick={dropped ? undefined : () => void download(a)}
            style={{
              all: "unset",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderRadius: "var(--dub-radius-md)",
              border: `1px solid ${dropped ? "var(--dub-color-border-default)" : "var(--dub-color-border-strong)"}`,
              cursor: dropped ? "not-allowed" : "pointer",
              opacity: dropped || busy === a.id ? 0.6 : 1,
              fontSize: "var(--dub-font-size-sm)",
              color: dropped ? "var(--dub-color-text-muted)" : "var(--dub-color-text-secondary)",
              maxWidth: 260,
            }}
          >
            <MailIcon name={dropped ? "alert" : "paperclip"} size={16} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.filename}</span>
            <span style={{ color: "var(--dub-color-text-muted)", flexShrink: 0 }}>
              {dropped ? reason : formatBytes(a.sizeBytes)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MessageBlock({
  msg,
  defaultOpen,
  subject,
  own,
}: {
  msg: MailMsg;
  defaultOpen: boolean;
  subject: string;
  own: ReadonlySet<string>;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [details, setDetails] = useState(false);
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
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
            <strong style={{ fontSize: "var(--dub-font-size-sm)", whiteSpace: "nowrap", flexShrink: 0 }}>{displayName(msg.from)}</strong>
            {open ? (
              <span
                style={{
                  fontSize: "var(--dub-font-size-xs)",
                  color: "var(--dub-color-text-muted)",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                &lt;{msg.from.email}&gt;
              </span>
            ) : null}
          </div>
          {open ? (
            <button
              type="button"
              data-testid="fe2-mail-details-toggle"
              aria-haspopup="dialog"
              aria-label={`宛先: ${recipientSummary(msg, own)}（詳細を表示）`}
              onClick={(e) => {
                e.stopPropagation();
                setDetails(true);
              }}
              style={{
                all: "unset",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                maxWidth: "100%",
                fontSize: "var(--dub-font-size-xs)",
                color: "var(--dub-color-text-muted)",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                宛先: {recipientSummary(msg, own)}
              </span>
              <MailIcon name="chevron-down" size={14} style={{ flexShrink: 0 }} />
            </button>
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
      {open ? <Attachments msg={msg} /> : null}
      {details ? <MessageDetailsDialog msg={msg} subject={subject} own={own} onClose={() => setDetails(false)} /> : null}
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
  const [replyCc, setReplyCc] = useState("");
  const [replyBcc, setReplyBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // Inline-reply attachments: same shared hook/tray/preview as the floating compose.
  const att = useComposeAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const candidates = useMemo(() => addressCandidates(state.threads, state.me.email), [state.threads, state.me.email]);
  // Grow the inline reply with its content (capped; scrolls beyond) so a long reply is
  // readable to the end instead of being squeezed into a fixed 4-row box.
  useLayoutEffect(() => {
    const el = replyRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [reply]);
  const lastIdx = thread.messages.length - 1;
  const own = ownAddresses(thread, state.me);
  const last = thread.messages[lastIdx]!;
  const nudge = replyNudge(thread, new Date(), pendingReplyIds(state.scheduled));
  const chips = thread.labels.map((id) => labels.find((l) => l.id === id)).filter((l): l is Label => Boolean(l));

  // Reply targets the last message that ISN'T ours — the external correspondent — never
  // our own reply (which is now folded into the conversation). `ourAddresses` are the From
  // addresses we sent as plus the address mail was delivered to us at, so reply-all drops them.
  const notUs = (p: MailPerson): boolean => p.email.length > 0 && !own.has(p.email.trim().toLowerCase());
  const replyTo = [...thread.messages].reverse().find((m) => !m.outbound) ?? last;
  // A Reply-To header redirects replies (RFC 5322 §3.6.2), as Gmail does.
  const sender = replyTo.headerMeta?.replyTo?.length ? replyTo.headerMeta.replyTo : [replyTo.from];
  const replyRecipients = replyTo.outbound ? replyTo.to.filter(notUs) : sender;
  const all = replyAllRecipients(replyTo, own);

  const openCompose = (mode: "reply" | "replyAll" | "forward"): void => {
    const to = mode === "forward" ? [] : mode === "replyAll" ? all.to : replyRecipients;
    const cc = mode === "replyAll" ? all.cc : [];
    const fmt = (ps: MailPerson[]): string => ps.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", ");
    dispatch({
      type: "OPEN_COMPOSE",
      compose: {
        mode,
        to: fmt(to),
        cc: fmt(cc),
        subject: `${mode === "forward" ? "Fwd" : "Re"}: ${thread.subject.replace(/^(Re|Fwd):\s*/i, "")}`,
        body: quote(replyTo),
        showCc: cc.length > 0,
        // Reply/replyAll thread against the correspondent's Message-Id; a forward is new.
        ...(mode !== "forward" && replyTo.messageId ? { inReplyTo: replyTo.messageId } : {}),
      },
    });
  };

  const replySubject = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`;
  const resetInline = (): void => {
    setReply("");
    setReplyCc("");
    setReplyBcc("");
    setShowCcBcc(false);
    att.clear();
  };

  const sendInline = (): void => {
    const body = reply.trim();
    if (body.length === 0 || replyRecipients.length === 0) return;
    if (att.hasPending) return;
    // Optimistic: append to the open thread immediately. Previously this was ALL that
    // happened — the reply never reached the gateway, so nothing was delivered. Now we
    // also POST it (with In-Reply-To via the parent Message-Id) and re-sync so the sent
    // reply is server-backed and survives a reload.
    const cc = parseRecipients(replyCc).recipients;
    const bcc = parseRecipients(replyBcc).recipients;
    dispatch({ type: "ADD_MESSAGE", threadId: thread.id, body, to: replyRecipients, cc, bcc, subject: thread.subject });
    const inputs = att.readyInputs();
    resetInline();
    const req: mail.SendMailRequest = {
      to: replyRecipients,
      subject: replySubject,
      textBody: body,
    };
    if (cc.length > 0) req.cc = cc;
    if (bcc.length > 0) req.bcc = bcc;
    if (replyTo.messageId) req.inReplyTo = replyTo.messageId;
    if (inputs.length > 0) req.attachments = inputs;
    void mailApi
      .send(req)
      .then(() => dispatch({ type: "REQUEST_SYNC" }))
      .catch(() => undefined);
  };

  // 予約送信 for the inline reply: same picker as the compose window. The reply keeps its
  // thread (inReplyTo), Cc/Bcc and attachments; it is NOT appended to the thread now — it
  // shows in 予約済み (and below, as a pending chip) and folds into the thread once delivered.
  // A failed schedule reopens the reply as a floating compose (deliver()), never lost.
  const scheduleInline = (when: Date): string | null => {
    const body = reply.trim();
    if (body.length === 0) return "本文を入力してください";
    if (replyRecipients.length === 0) return "宛先がありません";
    if (att.hasPending) return "添付ファイルを処理中です…";
    const cc = parseRecipients(replyCc).recipients;
    const bcc = parseRecipients(replyBcc).recipients;
    const req: mail.ScheduleMailRequest = { to: replyRecipients, subject: replySubject, textBody: body, scheduledAt: when.toISOString() };
    if (cc.length > 0) req.cc = cc;
    if (bcc.length > 0) req.bcc = bcc;
    if (replyTo.messageId) req.inReplyTo = replyTo.messageId;
    const inputs = att.readyInputs();
    if (inputs.length > 0) req.attachments = inputs;
    const fmt = (ps: MailPerson[]): string => ps.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", ");
    const compose = {
      id: uid("compose"),
      mode: "reply" as const,
      to: fmt(replyRecipients),
      cc: fmt(cc),
      bcc: fmt(bcc),
      subject: replySubject,
      body,
      showCc: cc.length > 0,
      showBcc: bcc.length > 0,
      minimized: false,
      maximized: false,
      ...(replyTo.messageId ? { inReplyTo: replyTo.messageId } : {}),
    };
    resetInline();
    void deliver(mailApi, dispatch, { kind: "schedule", req, compose });
    return null;
  };
  // Scheduled replies still waiting to go out for THIS thread (any message in it).
  const threadMessageIds = new Set(thread.messages.map((m) => (m.messageId ?? "").trim().replace(/^<|>$/g, "")).filter(Boolean));
  const scheduledHere = state.scheduled.filter(
    (s) => s.status === "scheduled" && s.inReplyTo && threadMessageIds.has(s.inReplyTo.trim().replace(/^<|>$/g, "")),
  );

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
        {state.folder === "trash" ? (
          <>
            <HeaderButton label="受信トレイに戻す" icon="inbox" onClick={() => dispatch({ type: "RESTORE", ids: [thread.id] })} testId="fe2-mail-restore" />
            <HeaderButton
              label="完全に削除"
              icon="delete-forever"
              onClick={() => confirmPurge(1) && dispatch({ type: "PURGE", ids: [thread.id] })}
              testId="fe2-mail-purge"
            />
          </>
        ) : (
          <>
            <HeaderButton label="アーカイブ" icon="archive" onClick={() => dispatch({ type: "ARCHIVE", ids: [thread.id] })} />
            <HeaderButton label="削除" icon="trash" onClick={() => dispatch({ type: "TRASH", ids: [thread.id] })} />
          </>
        )}
        {threadMine(thread) ? (
          <HeaderButton
            label={threadUnread(thread) ? "既読にする" : "未読にする"}
            icon="mail-open"
            onClick={() => dispatch({ type: "SET_READ", ids: [thread.id], read: threadUnread(thread) })}
          />
        ) : null}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ padding: "20px 24px 4px", display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: "var(--dub-font-size-xl)", fontWeight: 500, color: "var(--dub-color-text-primary)", flex: 1 }}>
            {thread.subject || "(件名なし)"}
          </h1>
          {threadMine(thread) ? null : (
            <span title="ロール共有・監督権限で閲覧しているメールです" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
              <Badge tone="info" testId="fe2-mail-shared-chip-pane">{sharedRecipientLabel(thread)}</Badge>
            </span>
          )}
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

        {nudge ? (
          <div className={styles.banner} data-reply-nudge="fe2-mail-reply-nudge" data-testid="fe2-mail-reply-nudge-banner">
            <span className={styles.text}>{nudge.days}日前に受信したメールにまだ返信していません</span>
            <span className={styles.actions}>
              <Button variant="secondary" size="sm" onClick={() => openCompose("reply")} testId="fe2-mail-reply-nudge-reply">
                返信
              </Button>
              {/* Literal marker survives minification so verify:live can grep the bundle. */}
              <span data-reply-nudge-dismiss="fe2-mail-reply-nudge-dismiss" style={{ display: "contents" }}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dispatch({ type: "DISMISS_NUDGE", ids: [thread.id] })}
                  testId="fe2-mail-reply-nudge-dismiss"
                >
                  返信不要
                </Button>
              </span>
            </span>
          </div>
        ) : null}

        {thread.messages.map((m, i) => (
          <MessageBlock key={m.id} msg={m} defaultOpen={i === lastIdx} subject={thread.subject} own={own} />
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

        {scheduledHere.length > 0 ? (
          <ul className={inlineStyles.scheduledList} data-testid="fe2-mail-thread-scheduled">
            {scheduledHere.map((s) => (
              <li key={s.id} className={inlineStyles.scheduledItem} data-testid="fe2-mail-thread-scheduled-item">
                <MailIcon name="clock" size={14} />
                <span>{fullDate(s.scheduledAt)} に返信を送信予定</span>
                {s.attachments && s.attachments.length > 0 ? (
                  <span className={inlineStyles.scheduledAttach}>
                    <MailIcon name="paperclip" size={12} /> {s.attachments.length}
                  </span>
                ) : null}
                <button type="button" className={inlineStyles.linkBtn} onClick={() => dispatch({ type: "SET_FOLDER", folder: "scheduled" })}>
                  予約済みを開く
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div style={{ padding: "0 24px 24px" }}>
          <div style={{ display: "flex", gap: 12, border: "1px solid var(--dub-color-border-strong)", borderRadius: "var(--dub-radius-lg)", padding: 12 }}>
            <Avatar p={state.me} size={32} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--dub-space-2, 8px)", marginBottom: "var(--dub-space-2, 8px)", fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)" }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  宛先: {replyRecipients.map((p) => displayName(p)).join(", ")}
                </span>
                {!showCcBcc ? (
                  <button type="button" data-testid="fe2-mail-inline-ccbcc-toggle" onClick={() => setShowCcBcc(true)} style={ccBccBtn}>
                    Cc/Bcc
                  </button>
                ) : null}
              </div>
              {showCcBcc ? (
                <div style={{ marginBottom: "var(--dub-space-2, 8px)" }}>
                  <EmailAddressSelect variant="flush" label="Cc" value={replyCc} onChange={setReplyCc} parse={parseRecipients} candidates={candidates} removeIcon={<MailIcon name="x" size={12} />} testId="fe2-mail-inline-cc" />
                  <EmailAddressSelect variant="flush" label="Bcc" value={replyBcc} onChange={setReplyBcc} parse={parseRecipients} candidates={candidates} removeIcon={<MailIcon name="x" size={12} />} testId="fe2-mail-inline-bcc" />
                </div>
              ) : null}
              <textarea
                ref={replyRef}
                data-testid="fe2-mail-inline-reply"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={`${displayName(replyRecipients[0] ?? state.me)} に返信…`}
                rows={reply ? 4 : 1}
                style={{
                  width: "100%",
                  resize: "none",
                  minHeight: reply ? 96 : undefined,
                  maxHeight: "60vh",
                  overflowY: "auto",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  boxSizing: "border-box",
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  color: "var(--dub-color-text-primary)",
                  fontSize: "var(--dub-font-size-md)",
                  fontFamily: "inherit",
                }}
              />
              {att.errors.length > 0 || att.items.length > 0 ? (
                <div className={inlineStyles.attachments}>
                  <AttachmentErrors errors={att.errors} onDismiss={att.dismissErrors} />
                  <AttachmentTray items={att.items} onRemove={att.remove} onOpen={setPreviewId} testId="fe2-mail-inline-attach-tray" />
                </div>
              ) : null}
              <AttachmentPreview items={att.items} openId={previewId} onClose={() => setPreviewId(null)} />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                data-testid="fe2-mail-inline-attach-input"
                onChange={(e) => {
                  att.addFiles(e.target.files);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              />
              {reply || att.items.length > 0 ? (
                <div className={inlineStyles.actions}>
                  <button
                    type="button"
                    data-testid="fe2-mail-inline-send"
                    onClick={sendInline}
                    disabled={att.hasPending}
                    style={{
                      all: "unset",
                      cursor: att.hasPending ? "not-allowed" : "pointer",
                      opacity: att.hasPending ? 0.6 : 1,
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
                  <SchedulePicker
                    testIdPrefix="fe2-mail-inline-schedule"
                    onSchedule={scheduleInline}
                    disabled={att.hasPending}
                    disabledReason="添付ファイルを処理中です…"
                    {...(att.items.length > 0 ? { hint: `添付ファイル ${att.items.length} 件も一緒に予約されます` } : {})}
                  />
                  <button
                    type="button"
                    aria-label="ファイルを添付"
                    data-testid="fe2-mail-inline-attach"
                    className={inlineStyles.iconBtn}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <MailIcon name="paperclip" size={18} />
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

const ccBccBtn: CSSProperties = {
  all: "unset",
  cursor: "pointer",
  flexShrink: 0,
  fontSize: "var(--dub-font-size-xs)",
  fontWeight: 600,
  color: "var(--dub-color-text-muted)",
};
