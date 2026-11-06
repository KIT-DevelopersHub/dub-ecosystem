// 下書き folder pane: the signed-in user's server drafts, newest first. A row reopens the compose
// window it came from; the trash icon discards it (Gmail 下書きを破棄). Not thread-backed.
import { Badge } from "@dub/ui";
import type { mail } from "@dub/types";
import { useMailApi } from "../MailProvider.tsx";
import { MailIcon } from "./icons.tsx";
import { relativeDate, snippet } from "./mailModel.ts";
import { useMailStore, type MailAction, type MailState } from "./useMailStore.tsx";

/** Reopen a draft: raise its window if it is already open, else open one on the saved copy. */
export function openDraft(state: MailState, dispatch: (a: MailAction) => void, d: mail.MailDraft): void {
  if (state.composes.some((c) => c.id === d.id)) {
    dispatch({ type: "UPDATE_COMPOSE", id: d.id, patch: { minimized: false } });
    return;
  }
  dispatch({
    type: "OPEN_COMPOSE",
    compose: {
      id: d.id,
      mode: d.mode,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      showCc: d.cc !== "",
      showBcc: d.bcc !== "",
      subject: d.subject,
      body: d.body,
      persisted: true,
      ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
      ...(d.attachments.length > 0 ? { seed: { source: "drafts" as const, messageId: d.id, attachments: d.attachments } } : {}),
    },
  });
}

export function DraftList(): JSX.Element {
  const { state, dispatch } = useMailStore();
  const api = useMailApi();
  const items = state.drafts;

  const discard = (d: mail.MailDraft): void => {
    dispatch({ type: "REMOVE_DRAFT", id: d.id });
    void api.deleteDraft(d.id).catch(() => dispatch({ type: "REQUEST_SYNC" }));
  };

  return (
    <section
      data-testid="fe2-mail-drafts"
      style={{ flex: 1, minWidth: 0, background: "var(--dub-color-surface-base)", borderRadius: "var(--dub-radius-lg)", border: "1px solid var(--dub-color-border-default)", overflowY: "auto" }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px", borderBottom: "1px solid var(--dub-color-border-default)" }}>
        <MailIcon name="draft" size={20} style={{ color: "var(--dub-color-brand-500)" }} />
        <h2 style={{ margin: 0, fontSize: "var(--dub-font-size-md)", fontWeight: 700, color: "var(--dub-color-text-primary)" }}>下書き</h2>
        <span style={{ color: "var(--dub-color-text-muted)", fontSize: "var(--dub-font-size-sm)" }}>{items.length}件</span>
      </header>

      {items.length === 0 ? (
        <div data-testid="fe2-mail-drafts-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "64px 24px", color: "var(--dub-color-text-muted)" }}>
          <MailIcon name="draft" size={40} style={{ color: "var(--dub-color-border-strong)" }} />
          <p style={{ margin: 0, fontSize: "var(--dub-font-size-sm)" }}>下書きはありません</p>
          <p style={{ margin: 0, fontSize: "var(--dub-font-size-xs)" }}>作成中のメールは自動で保存され、ここから続きを書けます。</p>
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((d) => (
            <li
              key={d.id}
              data-testid="fe2-mail-draft-row"
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: "1px solid var(--dub-color-border-default)" }}
            >
              <button
                type="button"
                data-testid="fe2-mail-draft-open"
                onClick={() => openDraft(state, dispatch, d)}
                style={{ all: "unset", cursor: "pointer", flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12, fontSize: "var(--dub-font-size-sm)" }}
              >
                <span style={{ width: 168, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dub-color-text-secondary)" }}>
                  {d.to.trim() || "(宛先なし)"}
                </span>
                <Badge tone="danger">下書き</Badge>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dub-color-text-primary)" }}>
                  {d.subject || "(件名なし)"}
                  <span style={{ color: "var(--dub-color-text-muted)" }}> — {snippet(d.body, 80)}</span>
                </span>
                {d.attachments.length > 0 ? <MailIcon name="paperclip" size={14} style={{ color: "var(--dub-color-text-muted)", flexShrink: 0 }} /> : null}
                <span style={{ flexShrink: 0, fontSize: "var(--dub-font-size-xs)", color: "var(--dub-color-text-muted)" }}>{relativeDate(d.updatedAt)}</span>
              </button>
              <button
                type="button"
                aria-label="下書きを破棄"
                data-testid="fe2-mail-draft-discard"
                onClick={() => discard(d)}
                style={{ all: "unset", cursor: "pointer", display: "inline-flex", padding: 4, color: "var(--dub-color-text-muted)" }}
              >
                <MailIcon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
