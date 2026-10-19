/// <reference lib="dom" />
// 「後で」 (Slack's Later): everything the user saved for later or set a reminder on,
// across channels, in the main pane. Tabs 保存済み / リマインダー / 完了; a row opens the
// message (ChatApp switches channel + jumps), and its hover actions complete it,
// unsave it, or change the reminder. Data is the per-user message prefs (this device),
// so edits are instant; only author names are fetched (skeleton until resolved).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Avatar, Icon, Menu, Skeleton, Tabs, useToast, type IconName, type MenuItem } from "@dub/ui";
import type { common, identity } from "@dub/types";
import { useOptionalChatRuntime } from "../context";
import {
  REMINDER_PRESETS,
  formatDue,
  reminderDueAt,
  useMessagePrefs,
  type ReminderPreset,
  type SavedMessageRef,
} from "../lib/message-prefs";
import { CustomReminderForm } from "./MessageActions";
import styles from "../styles/chat.module.css";

// Liveness marker: verify-live asserts this literal is in the served bundle.
export const LATER_MARKER = "fe6-later-sidebar";

export type LaterTab = "saved" | "reminders" | "completed";

export interface LaterViewProps {
  resolveChannelName: (id: common.ChannelId) => string | undefined;
  onOpen: (ref: SavedMessageRef) => void;
  onOpenMobileNav?: (() => void) | undefined;
}

function timeAgo(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function LaterView({ resolveChannelName, onOpen, onOpenMobileNav }: LaterViewProps) {
  const runtime = useOptionalChatRuntime();
  const { show } = useToast();
  const bookmarks = useMessagePrefs((s) => s.bookmarks);
  const reminders = useMessagePrefs((s) => s.reminders);
  const completed = useMessagePrefs((s) => s.completed);
  const toggleBookmark = useMessagePrefs((s) => s.toggleBookmark);
  const addReminder = useMessagePrefs((s) => s.addReminder);
  const rescheduleReminder = useMessagePrefs((s) => s.rescheduleReminder);
  const removeReminder = useMessagePrefs((s) => s.removeReminder);
  const complete = useMessagePrefs((s) => s.complete);
  const restore = useMessagePrefs((s) => s.restore);
  const [tab, setTab] = useState<LaterTab>("saved");
  const [customFor, setCustomFor] = useState<string | null>(null);
  const now = new Date();

  // Author names: one batch for every id shown; unresolvable ids settle as "メンバー".
  const [users, setUsers] = useState<Record<string, identity.UserSummary | null>>({});
  const authorIds = useMemo(
    () =>
      [...new Set([...bookmarks, ...reminders, ...completed].map((r) => r.authorId).filter((id): id is common.UserId => id !== null))],
    [bookmarks, reminders, completed],
  );
  useEffect(() => {
    const missing = authorIds.filter((id) => !(id in users));
    if (missing.length === 0 || !runtime) return;
    let alive = true;
    void runtime.api
      .resolveUsers(missing)
      .catch(() => [] as identity.UserSummary[])
      .then((list) => {
        if (!alive) return;
        setUsers((prev) => {
          const next = { ...prev };
          for (const id of missing) next[id] = list.find((u) => u.id === id) ?? null;
          return next;
        });
      });
    return () => {
      alive = false;
    };
  }, [authorIds, users, runtime]);

  const dueOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of reminders) {
      const cur = m.get(r.messageId);
      if (!cur || r.dueAt < cur) m.set(r.messageId, r.dueAt);
    }
    return m;
  }, [reminders]);
  const sortedReminders = useMemo(() => [...reminders].sort((a, b) => a.dueAt.localeCompare(b.dueAt)), [reminders]);

  const presetItems = (onPick: (when: ReminderPreset) => void, customKey: string, testPrefix: string): MenuItem[] => [
    ...REMINDER_PRESETS.map((p) => ({ id: p.id, label: p.label, testId: `${testPrefix}-${p.id}`, onSelect: () => onPick(p.id) })),
    { id: "custom", label: "カスタム…", dividerBefore: true, testId: `${testPrefix}-custom`, onSelect: () => setCustomFor(customKey) },
  ];

  const remindAt = (ref: SavedMessageRef, due: Date, reminderId?: string) => {
    if (reminderId) rescheduleReminder(reminderId, due);
    else addReminder(ref, due);
    setCustomFor(null);
    show({ kind: "success", title: `${formatDue(due, new Date())} にリマインドします` });
  };

  const onComplete = (ref: SavedMessageRef) => {
    complete(ref.messageId);
    show({ kind: "success", title: "完了にしました", description: "「完了」タブから戻せます" });
  };

  const row = (key: string, ref: SavedMessageRef, meta: ReactNode, actions: ReactNode, extra?: ReactNode) => {
    const user = ref.authorId ? users[ref.authorId] : undefined;
    const loadingName = ref.authorId !== null && !(ref.authorId in users);
    const name = ref.authorId === null ? "システム" : (user?.displayName ?? "メンバー");
    return (
      <li key={key} className={styles.laterRow} data-testid="fe6-later-row" data-message-id={ref.messageId}>
        <button type="button" className={styles.laterRowMain} onClick={() => onOpen(ref)} data-testid="fe6-later-open">
          <span className={styles.laterAvatar}>
            {loadingName ? <Skeleton variant="circle" width={36} height={36} /> : <Avatar name={name} src={user?.avatarUrl ?? undefined} size="md" />}
          </span>
          <span className={styles.laterText}>
            <span className={styles.laterHead}>
              {loadingName ? <Skeleton variant="text" width="6em" /> : <span className={styles.laterAuthor}>{name}</span>}
              <span className={styles.laterChannel}>{resolveChannelName(ref.channelId) ?? "チャンネル"}</span>
            </span>
            <span className={styles.laterExcerpt}>{ref.excerpt || "(添付ファイル)"}</span>
            <span className={styles.laterMeta}>{meta}</span>
          </span>
        </button>
        <span className={styles.laterActions} role="toolbar" aria-label="後でアイテムの操作">
          {actions}
        </span>
        {extra}
      </li>
    );
  };

  const iconBtn = (label: string, icon: IconName, onClick: () => void, testId: string) => (
    <button type="button" className={styles.hoverAction} aria-label={label} title={label} data-testid={testId} onClick={onClick}>
      <Icon name={icon} size="sm" />
    </button>
  );

  const customForm = (key: string, ref: SavedMessageRef, reminderId?: string) =>
    customFor === key ? (
      <div className={styles.laterCustom}>
        <CustomReminderForm onSubmit={(at) => remindAt(ref, at, reminderId)} />
      </div>
    ) : null;

  let list: ReactNode;
  if (tab === "saved") {
    list =
      bookmarks.length === 0 ? (
        <Empty title="保存済みのアイテムはありません" hint="メッセージの「その他」→「後で用に保存」で、ここにまとめて見返せます。" />
      ) : (
        bookmarks.map((b) => {
          const due = dueOf.get(b.messageId);
          const key = `saved:${b.messageId}`;
          return row(
            key,
            b,
            due ? (
              <span className={styles.laterDue}>⏰ {formatDue(new Date(due), now)}</span>
            ) : (
              <>保存日時 {timeAgo(b.savedAt, now)}</>
            ),
            <>
              {iconBtn("完了にする", "check", () => onComplete(b), "fe6-later-complete")}
              <Menu
                label="リマインダーを設定"
                icon="clock"
                iconOnly
                align="end"
                testId="fe6-later-remind"
                items={presetItems((p) => remindAt(b, reminderDueAt(p, new Date())), key, "fe6-later-remind")}
              />
              {iconBtn(
                "後で用の保存を解除",
                "x",
                () => {
                  toggleBookmark(b);
                  show({ kind: "success", title: "後で用の保存を解除しました" });
                },
                "fe6-later-unsave",
              )}
            </>,
            customForm(key, b),
          );
        })
      );
  } else if (tab === "reminders") {
    list =
      sortedReminders.length === 0 ? (
        <Empty title="リマインダーはありません" hint="メッセージの「その他」→「リマインダーを追加」で設定できます。" />
      ) : (
        sortedReminders.map((r) => {
          const key = `rem:${r.id}`;
          return row(
            key,
            r,
            <span className={styles.laterDue}>⏰ {formatDue(new Date(r.dueAt), now)}</span>,
            <>
              {iconBtn("完了にする", "check", () => onComplete(r), "fe6-later-complete")}
              <Menu
                label="リマインダーを変更"
                icon="clock"
                iconOnly
                align="end"
                testId="fe6-later-reschedule"
                items={presetItems((p) => remindAt(r, reminderDueAt(p, new Date()), r.id), key, "fe6-later-reschedule")}
              />
              {iconBtn(
                "リマインダーを削除",
                "trash",
                () => {
                  removeReminder(r.id);
                  show({ kind: "success", title: "リマインダーを削除しました" });
                },
                "fe6-later-remove-reminder",
              )}
            </>,
            customForm(key, r, r.id),
          );
        })
      );
  } else {
    list =
      completed.length === 0 ? (
        <Empty title="完了したアイテムはありません" hint="「完了にする」と、ここに移動します。" />
      ) : (
        completed.map((c) =>
          row(
            `done:${c.messageId}`,
            c,
            <>完了 {timeAgo(c.completedAt, now)}</>,
            iconBtn("「保存済み」に戻す", "refresh", () => restore(c.messageId), "fe6-later-restore"),
          ),
        )
      );
  }

  return (
    <section className={styles.main} data-testid="fe6-later-view" data-marker={LATER_MARKER}>
      <header className={styles.channelHeader}>
        <div className={styles.channelHeaderLeft}>
          {onOpenMobileNav && (
            <button type="button" className={styles.mobileMenuBtn} onClick={onOpenMobileNav} aria-label="チャネル一覧を開く" title="チャネル一覧">
              <Icon name="menu" size="sm" />
            </button>
          )}
          <span className={styles.channelTitle}>
            <span aria-hidden>🔖</span> 後で
          </span>
        </div>
      </header>
      <div className={styles.laterTabs}>
        <Tabs
          testId="fe6-later-tabs"
          activeId={tab}
          onChange={(id) => {
            setTab(id as LaterTab);
            setCustomFor(null);
          }}
          items={[
            { id: "saved", label: `保存済み${bookmarks.length ? ` ${bookmarks.length}` : ""}` },
            { id: "reminders", label: `リマインダー${reminders.length ? ` ${reminders.length}` : ""}` },
            { id: "completed", label: "完了" },
          ]}
        />
      </div>
      <ul className={styles.laterList} data-testid={`fe6-later-list-${tab}`}>
        {list}
      </ul>
    </section>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <li className={styles.laterEmpty} data-testid="fe6-later-empty">
      <span className={styles.laterEmptyIcon} aria-hidden>
        🔖
      </span>
      <strong>{title}</strong>
      <span>{hint}</span>
    </li>
  );
}
