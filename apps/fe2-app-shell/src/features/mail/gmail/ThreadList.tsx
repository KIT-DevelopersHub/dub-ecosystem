// Center pane: the dense conversation list — Gmail's signature surface. Each row
// is ~40px: leading checkbox, star toggle, bold sender (unread) / regular (read),
// subject + inline snippet, label chips, and a timestamp that swaps to row
// actions (archive / delete / mark-read) on hover. Bulk selection lifts a toolbar.
import { useState } from "react";
import {
  avatarColor,
  displayName,
  initial,
  inFolder,
  latest,
  matchesQuery,
  relativeDate,
  snippet,
  threadUnread,
  type Label,
  type MailThreadModel,
} from "./mailModel.ts";
import { MailIcon } from "./icons.tsx";
import { useMailStore } from "./useMailStore.tsx";

/** Confirm "完全に削除" (permanent, per-user, no restore). Returns true to proceed. Kept as a
 *  plain window.confirm so the irreversible action always demands an explicit OK; in a
 *  non-browser (test/SSR) context with no confirm it proceeds so unit tests can drive it. */
export function confirmPurge(count: number): boolean {
  const msg =
    count > 1
      ? `選択した${count}件の会話を完全に削除しますか？\nこの操作は取り消せません（あなたのメールボックスから完全に削除されます）。`
      : "この会話を完全に削除しますか？\nこの操作は取り消せません（あなたのメールボックスから完全に削除されます）。";
  return typeof window === "undefined" || typeof window.confirm !== "function" ? true : window.confirm(msg);
}

function LabelChips({ ids, labels }: { ids: string[]; labels: Label[] }): JSX.Element | null {
  const chips = ids.map((id) => labels.find((l) => l.id === id)).filter((l): l is Label => Boolean(l));
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((l) => (
        <span
          key={l.id}
          style={{
            fontSize: 11,
            lineHeight: "16px",
            padding: "0 6px",
            borderRadius: "var(--dub-radius-sm)",
            border: `1px solid ${l.color}`,
            color: "var(--dub-color-text-secondary)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {l.name}
        </span>
      ))}
    </>
  );
}

function StopClick({ children, onClick, label, testId }: { children: JSX.Element; onClick: () => void; label: string; testId?: string }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      {...(testId ? { "data-testid": testId } : {})}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ all: "unset", cursor: "pointer", display: "inline-flex", padding: 4, borderRadius: "var(--dub-radius-full)" }}
    >
      {children}
    </button>
  );
}

function ThreadRow({ thread, labels }: { thread: MailThreadModel; labels: Label[] }): JSX.Element {
  const { state, dispatch } = useMailStore();
  const [hover, setHover] = useState(false);
  const unread = threadUnread(thread);
  const last = latest(thread);
  const checked = state.checked.has(thread.id);
  const people = thread.folder === "sent" || thread.folder === "drafts" ? last.to[0] ?? state.me : last.from;

  return (
    <div
      role="row"
      data-testid="fe2-mail-inbox-item"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => dispatch({ type: "OPEN_THREAD", id: thread.id })}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 40,
        padding: "0 12px 0 8px",
        cursor: "pointer",
        borderBottom: "1px solid var(--dub-color-border-default)",
        background: checked
          ? "var(--dub-color-brand-50)"
          : unread
            ? "var(--dub-color-surface-base)"
            : "var(--dub-color-surface-sunken)",
        boxShadow: hover ? "inset 1px 0 0 var(--dub-color-border-strong), var(--dub-shadow-sm)" : "none",
      }}
    >
      <StopClick label={checked ? "選択を解除" : "スレッドを選択"} onClick={() => dispatch({ type: "TOGGLE_CHECK", id: thread.id })}>
        <span
          aria-hidden
          style={{
            width: 16,
            height: 16,
            borderRadius: 3,
            border: `2px solid ${checked ? "var(--dub-color-brand-500)" : "var(--dub-color-border-strong)"}`,
            background: checked ? "var(--dub-color-brand-500)" : "transparent",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
          }}
        >
          {checked ? <MailIcon name="check" size={12} /> : null}
        </span>
      </StopClick>

      <StopClick
        label={thread.starred ? "スターを外す" : "スターを付ける"}
        testId="fe2-mail-star"
        onClick={() => dispatch({ type: "TOGGLE_STAR", id: thread.id })}
      >
        <MailIcon
          name={thread.starred ? "star-filled" : "star"}
          size={18}
          style={{ color: thread.starred ? "#f4b400" : "var(--dub-color-text-muted)" }}
        />
      </StopClick>

      <span
        aria-hidden
        style={{
          width: 24,
          height: 24,
          borderRadius: "var(--dub-radius-full)",
          background: avatarColor(people),
          color: "#fff",
          fontSize: 12,
          fontWeight: 700,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {initial(people)}
      </span>

      <span
        style={{
          width: 168,
          flexShrink: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: "var(--dub-font-size-sm)",
          fontWeight: unread ? 700 : 400,
          color: "var(--dub-color-text-primary)",
        }}
      >
        {displayName(people)}
        {thread.messages.length > 1 ? (
          <span style={{ color: "var(--dub-color-text-muted)", fontWeight: 400 }}> {thread.messages.length}</span>
        ) : null}
      </span>

      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: "var(--dub-font-size-sm)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <LabelChips ids={thread.labels} labels={labels} />
        <span style={{ fontWeight: unread ? 700 : 400, color: "var(--dub-color-text-primary)" }}>{thread.subject}</span>
        <span style={{ color: "var(--dub-color-text-muted)", fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis" }}>
          {" — "}
          {snippet(last.body, 80)}
        </span>
      </span>

      <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "flex-end", minWidth: 96 }}>
        {hover ? (
          <span style={{ display: "inline-flex", gap: 2, color: "var(--dub-color-text-secondary)" }}>
            {state.folder === "trash" ? (
              <>
                <StopClick label="受信トレイに戻す" testId="fe2-mail-restore" onClick={() => dispatch({ type: "RESTORE", ids: [thread.id] })}>
                  <MailIcon name="inbox" size={18} />
                </StopClick>
                <StopClick
                  label="完全に削除"
                  testId="fe2-mail-purge"
                  onClick={() => confirmPurge(1) && dispatch({ type: "PURGE", ids: [thread.id] })}
                >
                  <MailIcon name="delete-forever" size={18} style={{ color: "var(--dub-color-danger-500, #d93025)" }} />
                </StopClick>
              </>
            ) : (
              <>
                <StopClick label="アーカイブ" testId="fe2-mail-archive" onClick={() => dispatch({ type: "ARCHIVE", ids: [thread.id] })}>
                  <MailIcon name="archive" size={18} />
                </StopClick>
                <StopClick label="削除" testId="fe2-mail-trash" onClick={() => dispatch({ type: "TRASH", ids: [thread.id] })}>
                  <MailIcon name="trash" size={18} />
                </StopClick>
              </>
            )}
            <StopClick
              label={unread ? "既読にする" : "未読にする"}
              onClick={() => dispatch({ type: "SET_READ", ids: [thread.id], read: unread })}
            >
              <MailIcon name={unread ? "mail-open" : "inbox"} size={18} />
            </StopClick>
          </span>
        ) : (
          <span
            style={{
              fontSize: "var(--dub-font-size-xs)",
              fontWeight: unread ? 700 : 400,
              color: unread ? "var(--dub-color-text-primary)" : "var(--dub-color-text-muted)",
            }}
          >
            {relativeDate(last.date)}
          </span>
        )}
      </span>
    </div>
  );
}

export function ThreadList(): JSX.Element {
  const { state, dispatch } = useMailStore();

  const visible = state.threads.filter((t) => {
    if (t.purged) return false; // 完全に削除: hidden from every folder for this viewer
    const scope = state.labelFilter
      ? t.labels.includes(state.labelFilter) && t.folder !== "trash"
      : inFolder(t, state.folder);
    return scope && matchesQuery(t, state.search);
  });

  const allChecked = visible.length > 0 && visible.every((t) => state.checked.has(t.id));
  const someChecked = state.checked.size > 0;
  const checkedInView = visible.filter((t) => state.checked.has(t.id)).map((t) => t.id);

  return (
    <section
      data-testid="fe2-mail-inbox"
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          height: 44,
          padding: "0 12px 0 8px",
          borderBottom: "1px solid var(--dub-color-border-default)",
        }}
      >
        <StopClick
          label={allChecked ? "全選択を解除" : "すべて選択"}
          testId="fe2-mail-select-all"
          onClick={() =>
            allChecked || someChecked ? dispatch({ type: "CLEAR_CHECKS" }) : dispatch({ type: "CHECK_ALL", ids: visible.map((t) => t.id) })
          }
        >
          <span
            aria-hidden
            style={{
              width: 16,
              height: 16,
              borderRadius: 3,
              border: `2px solid ${allChecked || someChecked ? "var(--dub-color-brand-500)" : "var(--dub-color-border-strong)"}`,
              background: allChecked ? "var(--dub-color-brand-500)" : "transparent",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
            }}
          >
            {allChecked ? <MailIcon name="check" size={12} /> : someChecked ? <MailIcon name="minus" size={12} style={{ color: "var(--dub-color-brand-500)" }} /> : null}
          </span>
        </StopClick>

        {someChecked ? (
          <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--dub-color-text-secondary)" }}>
            {state.folder === "trash" ? (
              <>
                <StopClick label="選択を受信トレイに戻す" testId="fe2-mail-restore-bulk" onClick={() => dispatch({ type: "RESTORE", ids: checkedInView })}>
                  <MailIcon name="inbox" size={18} />
                </StopClick>
                <StopClick
                  label="選択を完全に削除"
                  testId="fe2-mail-purge-bulk"
                  onClick={() => confirmPurge(checkedInView.length) && dispatch({ type: "PURGE", ids: checkedInView })}
                >
                  <MailIcon name="delete-forever" size={18} style={{ color: "var(--dub-color-danger-500, #d93025)" }} />
                </StopClick>
              </>
            ) : (
              <>
                <StopClick label="選択をアーカイブ" onClick={() => dispatch({ type: "ARCHIVE", ids: checkedInView })}>
                  <MailIcon name="archive" size={18} />
                </StopClick>
                <StopClick label="選択を削除" onClick={() => dispatch({ type: "TRASH", ids: checkedInView })}>
                  <MailIcon name="trash" size={18} />
                </StopClick>
              </>
            )}
            <StopClick label="選択を既読にする" onClick={() => dispatch({ type: "SET_READ", ids: checkedInView, read: true })}>
              <MailIcon name="mail-open" size={18} />
            </StopClick>
            <span style={{ fontSize: "var(--dub-font-size-xs)", marginLeft: 4 }}>{state.checked.size}件を選択中</span>
          </div>
        ) : (
          <button
            type="button"
            aria-label="更新"
            onClick={() => dispatch({ type: "CLEAR_CHECKS" })}
            style={{ all: "unset", cursor: "pointer", color: "var(--dub-color-text-secondary)", padding: 4 }}
          >
            <MailIcon name="refresh" size={18} />
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div
          data-testid="fe2-mail-inbox-empty"
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "var(--dub-color-text-muted)",
            padding: 48,
          }}
        >
          <MailIcon name="mail-open" size={48} style={{ opacity: 0.4 }} />
          <div style={{ fontSize: "var(--dub-font-size-md)", fontWeight: 600 }}>メールはありません</div>
          <div style={{ fontSize: "var(--dub-font-size-sm)" }}>該当するスレッドが見つかりませんでした。</div>
        </div>
      ) : (
        <div role="rowgroup" style={{ flex: 1, overflowY: "auto" }}>
          {visible.map((t) => (
            <ThreadRow key={t.id} thread={t} labels={state.labels} />
          ))}
        </div>
      )}
    </section>
  );
}
