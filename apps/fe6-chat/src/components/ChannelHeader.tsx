/// <reference lib="dom" />
// Channel top bar: #name (opens settings when moderator), topic, member roster
// popover, pinned-messages popover, and in-channel search. Presentational — all
// data + async come from ChannelPage via props. Slack-style layout, tokens/CSS.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Avatar, Icon } from "@dub/ui";
import type { common, identity } from "@dub/types";
import type { Channel, ChannelMember, Message } from "../api/contract";
import { getPresence } from "../lib/presence";
import styles from "../styles/chat.module.css";

export interface ChannelHeaderProps {
  channel: Channel;
  canModerate: boolean;
  members: ChannelMember[];
  pinned: Message[];
  searchValue: string;
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  onOpenSettings?: () => void;
  onSearchChange: (value: string) => void;
  onUnpin?: (messageId: common.MessageId) => void;
  onJumpToMessage?: (messageId: common.MessageId) => void;
}

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return "?";
  if (p.length === 1) return (p[0]?.slice(0, 2) ?? "?").toUpperCase();
  return `${p[0]?.[0] ?? ""}${p[p.length - 1]?.[0] ?? ""}`.toUpperCase();
}

/** Small dropdown wrapper: a trigger button + a panel that closes on outside click / Esc. */
function Dropdown({
  trigger,
  triggerClassName,
  triggerLabel,
  testId,
  children,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  triggerLabel: string;
  testId?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className={styles.headerDropdownWrap} ref={ref}>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={triggerLabel}
        title={triggerLabel}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div id={id} role="dialog" className={styles.headerDropdownPanel}>
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}

export function ChannelHeader({
  channel,
  canModerate,
  members,
  pinned,
  searchValue,
  resolveUser,
  onOpenSettings,
  onSearchChange,
  onUnpin,
  onJumpToMessage,
}: ChannelHeaderProps) {
  const isDm = channel.type === "dm";
  const nameOf = (id: common.UserId): string => resolveUser?.(id)?.displayName ?? id;

  return (
    <header className={styles.channelHeader} data-testid="fe6-channel-header">
      <div className={styles.channelHeaderLeft}>
        <button
          type="button"
          className={styles.channelTitle}
          onClick={canModerate ? onOpenSettings : undefined}
          data-testid={canModerate ? "fe6-channel-settings-open" : undefined}
          title={canModerate ? "チャンネル設定" : undefined}
        >
          {!isDm && <span className={styles.channelTitleHash}>#</span>}
          <span>{channel.name}</span>
          <span aria-hidden style={{ fontSize: "0.7em", opacity: 0.6 }}>▾</span>
        </button>
        {channel.topic && <span className={styles.channelTopic}>{channel.topic}</span>}
      </div>

      <div className={styles.channelHeaderRight}>
        {/* member roster */}
        <Dropdown
          trigger={
            <>
              <Icon name="users" size="sm" />
              <span>{channel.memberCount}</span>
            </>
          }
          triggerClassName={styles.memberChip}
          triggerLabel="メンバー"
          testId="fe6-members-open"
        >
          {() => (
            <div className={styles.rosterPanel} data-testid="fe6-members-panel">
              <div className={styles.dropdownTitle}>メンバー · {members.length}</div>
              <ul className={styles.rosterList}>
                {members.map((m) => (
                  <li key={m.userId} className={styles.rosterItem}>
                    <Avatar name={nameOf(m.userId)} src={resolveUser?.(m.userId)?.avatarUrl ?? undefined} size="sm" />
                    <span className={`${styles.presenceDot} ${styles[getPresence(m.userId)]}`} aria-hidden />
                    <span className={styles.rosterName}>{nameOf(m.userId)}</span>
                    {m.role === "admin" && <span className={styles.rosterRole}>管理者</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dropdown>

        {/* pinned messages */}
        <Dropdown
          trigger={
            <>
              <Icon name="pin" size="sm" />{pinned.length > 0 && <span className={styles.pinCount}>{pinned.length}</span>}
            </>
          }
          triggerClassName={styles.iconBtn}
          triggerLabel="ピン留めアイテム"
          testId="fe6-pins-open"
        >
          {(close) => (
            <div className={styles.pinsPanel} data-testid="fe6-pins-panel">
              <div className={styles.dropdownTitle}>ピン留めアイテム · {pinned.length}</div>
              {pinned.length === 0 ? (
                <div className={styles.dropdownEmpty}>まだピン留めはありません</div>
              ) : (
                <ul className={styles.pinsList}>
                  {pinned.map((m) => (
                    <li key={m.id} className={styles.pinsItem}>
                      <div className={styles.pinsAuthor}>{initials(nameOf(m.authorId))}</div>
                      <button
                        type="button"
                        className={styles.pinsBody}
                        onClick={() => {
                          onJumpToMessage?.(m.id);
                          close();
                        }}
                      >
                        {m.body.slice(0, 120) || "(添付ファイル)"}
                      </button>
                      <button
                        type="button"
                        className={styles.pinsUnpin}
                        aria-label="ピン留めを解除"
                        title="ピン留めを解除"
                        onClick={() => onUnpin?.(m.id)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Dropdown>

        <label className={styles.searchBox}>
          <Icon name="search" size="sm" />
          <input
            type="search"
            placeholder="検索"
            aria-label="メッセージを検索"
            data-testid="fe6-search-input"
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </label>
      </div>
    </header>
  );
}
