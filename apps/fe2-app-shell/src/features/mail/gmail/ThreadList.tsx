// Center pane: the dense conversation list — Gmail's signature surface. Each row
// is ~40px: leading checkbox, star toggle, bold sender (unread) / regular (read),
// subject + inline snippet, label chips, and a timestamp that swaps to row
// actions (archive / delete / mark-read) on hover. Bulk selection lifts a toolbar.
import { useEffect, useRef, useState } from "react";
import { Badge, NARROW_VIEWPORT_QUERY, useMediaQuery } from "@dub/ui";
import {
  avatarColor,
  displayName,
  initial,
  inFolder,
  latest,
  matchesQuery,
  partitionNudged,
  pendingReplyIds,
  relativeDate,
  replyNudge,
  sharedRecipientLabel,
  snippet,
  threadMine,
  threadUnread,
  type Label,
  type MailThreadModel,
} from "./mailModel.ts";
import { MailIcon } from "./icons.tsx";
import { useMailStore } from "./useMailStore.tsx";

// P25: exit-animation two-phase pattern (mirrors fe1 Toast.tsx's `leaving` + EXIT_MS).
// Archive/trash marks the row `leaving` (slide-out + collapse plays via inline styles),
// then the real ARCHIVE/TRASH dispatch — which is what actually drops the thread out of
// `visible` below — fires only after EXIT_MS, keeping the row mounted (and animatable)
// for the whole exit. Keep this in sync with --dub-motion-normal (200ms).
const EXIT_MS = 200;

// File-local reduced-motion check (same shape as fe1 SortableList's helper) — no shared
// hook exists yet, so this stays local per file per Minimal Impact.
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

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

/** Divider row above a group of threads. Passing `onToggle` makes it a collapse button. */
function SectionHeader({
  title,
  count,
  accent,
  open,
  onToggle,
  testId,
}: {
  title: string;
  count?: number;
  accent?: boolean;
  open?: boolean;
  onToggle?: () => void;
  testId: string;
}): JSX.Element {
  const label = count === undefined ? title : `${title} ${count}件`;
  return (
    <div
      role="row"
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "center",
        height: 32,
        padding: "0 12px",
        borderBottom: "1px solid var(--dub-color-border-default)",
        borderLeft: `4px solid ${accent ? "var(--dub-color-warning-500)" : "transparent"}`,
        background: "var(--dub-color-surface-raised)",
        fontSize: "var(--dub-font-size-xs)",
        fontWeight: 600,
        color: "var(--dub-color-text-secondary)",
      }}
    >
      {onToggle ? (
        <button
          type="button"
          aria-expanded={open}
          data-testid={`${testId}-toggle`}
          onClick={onToggle}
          style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <MailIcon name={open ? "chevron-down" : "chevron-right"} size={16} />
          {label}
        </button>
      ) : (
        label
      )}
    </div>
  );
}

function ThreadRow({
  thread,
  labels,
  leaving,
  narrow,
  now,
  pendingReplies,
  onArchive,
  onTrash,
  onDismissNudge,
}: {
  thread: MailThreadModel;
  labels: Label[];
  leaving: boolean;
  /** Phones: sender and subject stack on two lines; no hover-only actions. */
  narrow: boolean;
  /** Render-time clock for the reply nudge (one per list render). */
  now: Date;
  /** Message-Ids with a scheduled reply pending (suppresses the nudge). */
  pendingReplies: ReadonlySet<string>;
  onArchive: () => void;
  onTrash: () => void;
  /** Rows inside the pinned 返信待ち group get an always-visible 返信不要 control. */
  onDismissNudge?: () => void;
}): JSX.Element {
  const { state, dispatch } = useMailStore();
  const [hover, setHover] = useState(false);
  const unread = threadUnread(thread);
  const last = latest(thread);
  const checked = state.checked.has(thread.id);
  const nudge = replyNudge(thread, now, pendingReplies);
  const people = thread.folder === "sent" || thread.folder === "drafts" ? last.to[0] ?? state.me : last.from;

  // 返信不要 inside the pinned group: always visible (phones have no hover); on phones it sits
  // under the date so the subject keeps its width. Literal marker survives minification.
  const dismissNudge =
    nudge && onDismissNudge ? (
      <span data-reply-nudge-dismiss="fe2-mail-reply-nudge-dismiss" style={{ display: "contents" }}>
        <StopClick label="返信不要にする" testId="fe2-mail-reply-nudge-dismiss-row" onClick={onDismissNudge}>
          <span
            style={{
              flexShrink: 0,
              whiteSpace: "nowrap",
              padding: "var(--dub-space-1) var(--dub-space-3)",
              border: "1px solid var(--dub-color-border-default)",
              borderRadius: "var(--dub-radius-full)",
              fontSize: "var(--dub-font-size-xs)",
              color: "var(--dub-color-text-secondary)",
              background: "var(--dub-color-surface-base)",
            }}
          >
            返信不要
          </span>
        </StopClick>
      </span>
    ) : null;

  // P25: `data-thread-row` is a static marker (literal string, survives minification) so a
  // live-deploy check can grep the built bundle for this row without depending on RTL testids.
  return (
    <div
      role="row"
      data-testid="fe2-mail-inbox-item"
      data-thread-row="fe2-mail-thread-row"
      data-leaving={leaving ? "true" : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => dispatch({ type: "OPEN_THREAD", id: thread.id })}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: leaving ? 0 : narrow ? 64 : 40,
        padding: "0 12px 0 8px",
        cursor: leaving ? "default" : "pointer",
        overflow: "hidden",
        opacity: leaving ? 0 : 1,
        transform: leaving ? "translateX(24px)" : "translateX(0)",
        pointerEvents: leaving ? "none" : "auto",
        borderBottomWidth: leaving ? 0 : 1,
        borderBottomStyle: "solid",
        borderBottomColor: "var(--dub-color-border-default)",
        transition:
          "opacity var(--dub-motion-normal) var(--dub-motion-easing), " +
          "transform var(--dub-motion-normal) var(--dub-motion-easing), " +
          "height var(--dub-motion-normal) var(--dub-motion-easing), " +
          "border-bottom-width var(--dub-motion-normal) var(--dub-motion-easing)",
        background: checked
          ? "var(--dub-color-brand-50)"
          : unread
            ? "var(--dub-color-surface-base)"
            : "var(--dub-color-surface-sunken)",
        boxShadow: hover && !leaving ? "inset 1px 0 0 var(--dub-color-border-strong), var(--dub-shadow-sm)" : "none",
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

      {/* Phones stack sender over subject so neither collapses to nothing. */}
      <span style={narrow ? { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 } : { display: "contents" }}>
        <span
          style={{
            width: narrow ? "auto" : 168,
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
          {threadMine(thread) ? null : (
            <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
              <Badge tone="info" testId="fe2-mail-shared-chip">{sharedRecipientLabel(thread)}</Badge>
            </span>
          )}
          <LabelChips ids={thread.labels} labels={labels} />
          {/* Subject yields width (ellipsis) so the nudge badge after it never gets clipped. */}
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: unread ? 700 : 400,
              color: "var(--dub-color-text-primary)",
            }}
          >
            {thread.subject}
          </span>
          {nudge ? (
            // Literal marker survives minification so verify:live can grep the bundle.
            <span data-reply-nudge="fe2-mail-reply-nudge" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
              <Badge tone="warning" testId="fe2-mail-reply-nudge">
                {`${nudge.days}日前・未返信`}
              </Badge>
            </span>
          ) : null}
          <span style={{ color: "var(--dub-color-text-muted)", fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis" }}>
            {" — "}
            {snippet(last.body, 80)}
          </span>
        </span>
      </span>

      {narrow ? null : dismissNudge}

      <span
        style={{
          flexShrink: 0,
          display: "inline-flex",
          flexDirection: narrow ? "column" : "row",
          alignItems: narrow ? "flex-end" : "center",
          justifyContent: "flex-end",
          gap: "var(--dub-space-1)",
          minWidth: narrow ? 0 : 96,
        }}
      >
        {hover && !narrow ? (
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
                <StopClick label="アーカイブ" testId="fe2-mail-archive" onClick={onArchive}>
                  <MailIcon name="archive" size={18} />
                </StopClick>
                <StopClick label="削除" testId="fe2-mail-trash" onClick={onTrash}>
                  <MailIcon name="trash" size={18} />
                </StopClick>
              </>
            )}
            {threadMine(thread) ? (
              <StopClick
                label={unread ? "既読にする" : "未読にする"}
                onClick={() => dispatch({ type: "SET_READ", ids: [thread.id], read: unread })}
              >
                <MailIcon name={unread ? "mail-open" : "inbox"} size={18} />
              </StopClick>
            ) : null}
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
        {narrow ? dismissNudge : null}
      </span>
    </div>
  );
}

export function ThreadList(): JSX.Element {
  const { state, dispatch } = useMailStore();
  const narrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const now = new Date();
  const pendingReplies = pendingReplyIds(state.scheduled);
  const [nudgeOpen, setNudgeOpen] = useState(true);
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set());
  const leaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = leaveTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // P25: reduced-motion skips straight to the real (today's instant) dispatch. Otherwise
  // mark `ids` leaving so ThreadRow can play its slide-out/collapse, and only fire the real
  // ARCHIVE/TRASH dispatch (which drops the thread out of `visible`) after EXIT_MS. Ids
  // already leaving are ignored defensively (bulk toolbar has no per-row pointerEvents guard).
  function beginLeave(ids: string[], type: "ARCHIVE" | "TRASH"): void {
    if (prefersReducedMotion()) {
      dispatch({ type, ids });
      return;
    }
    const fresh = ids.filter((id) => !leavingIds.has(id));
    if (fresh.length === 0) return;
    setLeavingIds((prev) => {
      const next = new Set(prev);
      fresh.forEach((id) => next.add(id));
      return next;
    });
    const timer = setTimeout(() => {
      dispatch({ type, ids: fresh });
      setLeavingIds((prev) => {
        const next = new Set(prev);
        fresh.forEach((id) => next.delete(id));
        return next;
      });
      fresh.forEach((id) => leaveTimers.current.delete(id));
    }, EXIT_MS);
    fresh.forEach((id) => leaveTimers.current.set(id, timer));
  }

  const visible = state.threads.filter((t) => {
    if (t.purged) return false; // 完全に削除: hidden from every folder for this viewer
    const scope = state.labelFilter
      ? t.labels.includes(state.labelFilter) && t.folder !== "trash"
      : inFolder(t, state.folder);
    return scope && matchesQuery(t, state.search);
  });

  // Inbox only: unanswered mail is pinned on top so it can't sink under newer arrivals.
  const { nudged, rest } =
    state.folder === "inbox" && !state.labelFilter
      ? partitionNudged(visible, now, pendingReplies)
      : { nudged: [], rest: visible };
  const renderRow = (t: MailThreadModel, pinned = false): JSX.Element => (
    <ThreadRow
      key={t.id}
      thread={t}
      labels={state.labels}
      leaving={leavingIds.has(t.id)}
      narrow={narrow}
      now={now}
      pendingReplies={pendingReplies}
      onArchive={() => beginLeave([t.id], "ARCHIVE")}
      onTrash={() => beginLeave([t.id], "TRASH")}
      {...(pinned ? { onDismissNudge: () => dispatch({ type: "DISMISS_NUDGE", ids: [t.id] }) } : {})}
    />
  );

  // Bulk actions only reach rows on screen (a collapsed 返信待ち group is off-limits).
  const shown = nudgeOpen ? [...nudged, ...rest] : rest;
  const allChecked = shown.length > 0 && shown.every((t) => state.checked.has(t.id));
  const someChecked = state.checked.size > 0;
  const checkedInView = shown.filter((t) => state.checked.has(t.id)).map((t) => t.id);

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
            allChecked || someChecked ? dispatch({ type: "CLEAR_CHECKS" }) : dispatch({ type: "CHECK_ALL", ids: shown.map((t) => t.id) })
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
                <StopClick label="選択をアーカイブ" onClick={() => beginLeave(checkedInView, "ARCHIVE")}>
                  <MailIcon name="archive" size={18} />
                </StopClick>
                <StopClick label="選択を削除" onClick={() => beginLeave(checkedInView, "TRASH")}>
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
            data-testid="fe2-mail-refresh"
            onClick={() => dispatch({ type: "REQUEST_SYNC" })}
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
          {nudged.length > 0 ? (
            // Literal marker survives minification so verify:live can grep the bundle.
            <div data-reply-nudge-pinned="fe2-mail-reply-nudge-pinned" style={{ display: "contents" }}>
              <SectionHeader
                title="返信待ち"
                count={nudged.length}
                accent
                open={nudgeOpen}
                onToggle={() => setNudgeOpen((o) => !o)}
                testId="fe2-mail-nudge-section"
              />
              {nudgeOpen ? nudged.map((t) => renderRow(t, true)) : null}
              {rest.length > 0 ? <SectionHeader title="その他" testId="fe2-mail-rest-section" /> : null}
            </div>
          ) : null}
          {rest.map((t) => renderRow(t))}
        </div>
      )}
    </section>
  );
}
