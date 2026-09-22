// Scheduled folder (予約済み) pane. Lists the signed-in user's parked future sends
// (GET /mail/scheduled) with, per row, when it will go out, to whom, and actions to
// 編集 (reschedule: reopens a prefilled compose and cancels the parked row so the user
// re-schedules) or 取消 (cancel). Not thread-backed — it reads the store's `scheduled`
// slice, which useMailSync hydrates. Visuals are @dub/tokens; icons are our own.
import type { mail } from "@dub/types";
import { useMailApi } from "../MailProvider.tsx";
import { fullDate } from "./mailModel.ts";
import { MailIcon } from "./icons.tsx";
import { useMailStore } from "./useMailStore.tsx";

function addressLine(list: mail.MailAddress[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
}

export function ScheduledList(): JSX.Element {
  const { state, dispatch } = useMailStore();
  const api = useMailApi();
  const items = state.scheduled;

  const cancel = (id: string): void => {
    // Optimistic: drop it from the list now; the DELETE follows.
    dispatch({ type: "HYDRATE_SCHEDULED", scheduled: items.filter((s) => s.id !== id) });
    void api.cancelScheduled(id).then(() => dispatch({ type: "REQUEST_SYNC" })).catch(() => dispatch({ type: "REQUEST_SYNC" }));
  };

  const edit = (item: mail.ScheduledSendListItem): void => {
    // Load the full body, open a prefilled compose, and cancel the parked row so the user
    // edits + re-schedules from the compose window (single source of truth for compose).
    void api
      .getScheduled(item.id)
      .then((detail) => {
        dispatch({
          type: "OPEN_COMPOSE",
          compose: {
            to: addressLine(detail.to),
            cc: detail.cc && detail.cc.length > 0 ? addressLine(detail.cc) : "",
            showCc: Boolean(detail.cc && detail.cc.length > 0),
            subject: detail.subject,
            body: detail.textBody,
            ...(detail.inReplyTo ? { inReplyTo: detail.inReplyTo, mode: "reply" as const } : {}),
          },
        });
        return api.cancelScheduled(item.id);
      })
      .then(() => dispatch({ type: "REQUEST_SYNC" }))
      .catch(() => undefined);
  };

  return (
    <section
      data-testid="fe2-mail-scheduled"
      style={{ flex: 1, minWidth: 0, background: "var(--dub-color-surface-base)", borderRadius: "var(--dub-radius-lg)", border: "1px solid var(--dub-color-border-default)", overflowY: "auto" }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px", borderBottom: "1px solid var(--dub-color-border-default)" }}>
        <MailIcon name="clock" size={20} style={{ color: "var(--dub-color-brand-500)" }} />
        <h2 style={{ margin: 0, fontSize: "var(--dub-font-size-md)", fontWeight: 700, color: "var(--dub-color-text-primary)" }}>予約済み</h2>
        <span style={{ color: "var(--dub-color-text-muted)", fontSize: "var(--dub-font-size-sm)" }}>{items.length}件</span>
      </header>

      {items.length === 0 ? (
        <div data-testid="fe2-mail-scheduled-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "64px 24px", color: "var(--dub-color-text-muted)" }}>
          <MailIcon name="clock" size={40} style={{ color: "var(--dub-color-border-strong)" }} />
          <p style={{ margin: 0, fontSize: "var(--dub-font-size-sm)" }}>予約中のメールはありません</p>
          <p style={{ margin: 0, fontSize: "var(--dub-font-size-xs)" }}>作成画面の時計アイコンから送信日時を設定できます。</p>
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="fe2-mail-scheduled-row"
              style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 20px", borderBottom: "1px solid var(--dub-color-border-subtle, var(--dub-color-border-default))" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: "var(--dub-radius-full)", background: "var(--dub-color-brand-100)", color: "var(--dub-color-brand-700)", fontSize: "var(--dub-font-size-xs)", fontWeight: 600, flexShrink: 0 }}>
                    <MailIcon name="clock" size={12} />
                    {fullDate(item.scheduledAt)}
                  </span>
                  <span style={{ fontWeight: 600, color: "var(--dub-color-text-primary)", fontSize: "var(--dub-font-size-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.subject || "(件名なし)"}
                  </span>
                </div>
                <span style={{ color: "var(--dub-color-text-muted)", fontSize: "var(--dub-font-size-xs)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  宛先: {addressLine(item.to)}
                </span>
                {item.snippet ? (
                  <span style={{ color: "var(--dub-color-text-secondary)", fontSize: "var(--dub-font-size-xs)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.snippet}</span>
                ) : null}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <button
                  type="button"
                  data-testid="fe2-mail-scheduled-edit"
                  onClick={() => edit(item)}
                  style={{ all: "unset", cursor: "pointer", padding: "6px 12px", borderRadius: "var(--dub-radius-md)", border: "1px solid var(--dub-color-border-default)", color: "var(--dub-color-text-secondary)", fontSize: "var(--dub-font-size-xs)", fontWeight: 600 }}
                >
                  編集
                </button>
                <button
                  type="button"
                  data-testid="fe2-mail-scheduled-cancel"
                  onClick={() => cancel(item.id)}
                  style={{ all: "unset", cursor: "pointer", padding: "6px 12px", borderRadius: "var(--dub-radius-md)", color: "var(--dub-color-danger-600)", fontSize: "var(--dub-font-size-xs)", fontWeight: 600 }}
                >
                  取消
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
