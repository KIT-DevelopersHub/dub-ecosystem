// Dark "workspace" sidebar: collapsible sections (Channels / DMs / Events),
// #-prefixed channels, presence dots on DMs, unread = bold name + mention/count
// badge. "New channel" (+) is gated by can("chat:create") upstream via canCreate.
// Slack-style information design — built from @dub/ui + own glyphs, no Slack assets.
import { useState } from "react";
import { Icon, Skeleton } from "@dub/ui";
import type { common } from "@dub/types";
import type { Channel, ChannelType } from "../api/contract";
import { groupChannels, type ChannelGroup } from "../lib/channel-group";
import { getPresence, type Presence } from "../lib/presence";
import type { UnreadMap } from "../store/unread";
import styles from "../styles/chat.module.css";

export interface ChannelListProps {
  channels: Channel[];
  unread: UnreadMap;
  activeChannelId: common.ChannelId | null;
  canCreate: boolean;
  workspaceName?: string;
  onSelect: (channelId: common.ChannelId) => void;
  onCreate?: () => void;
  // DM row label ("the other side"); null = still resolving -> skeleton. Defaults to name.
  labelOf?: (channel: Channel) => string | null;
  // New-DM (+) on the ダイレクト section. Shown even with no DMs yet, so the first
  // conversation can be started from the sidebar.
  onNewDm?: () => void;
  // Set only when rendered inside the mobile nav drawer (P21) — adds a close (X)
  // affordance next to the workspace name so the drawer can be dismissed without
  // picking a channel first (backdrop-tap / Esc already close it too).
  onCloseMobile?: () => void;
}

function Dot({ p }: { p: Presence }) {
  return <span className={`${styles.presenceDot} ${styles[p]}`} aria-hidden />;
}

export function ChannelList({
  channels,
  unread,
  activeChannelId,
  canCreate,
  workspaceName = "DevHub",
  onSelect,
  onCreate,
  labelOf = (c) => c.name,
  onNewDm,
  onCloseMobile,
}: ChannelListProps) {
  const grouped = groupChannels(channels);
  const groups: ChannelGroup[] =
    onNewDm && !grouped.some((g) => g.type === "dm") ? [...grouped, { type: "dm", label: "ダイレクト", channels: [] }] : grouped;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (t: ChannelType) => setCollapsed((c) => ({ ...c, [t]: !c[t] }));

  return (
    <nav className={styles.sidebar} aria-label="チャネル一覧" data-testid="fe6-channel-list">
      <div className={styles.workspaceHeader}>
        <span className={styles.workspaceName}>{workspaceName}</span>
        <span className={styles.workspaceHeaderActions}>
          {canCreate && (
            <button
              type="button"
              className={styles.workspaceAction}
              onClick={onCreate}
              data-testid="fe6-channel-create"
              aria-label="チャネルを作成"
              title="チャネルを作成"
            >
              ＋
            </button>
          )}
          {onCloseMobile && (
            <button
              type="button"
              className={styles.workspaceAction}
              onClick={onCloseMobile}
              data-testid="fe6-mobile-nav-close"
              aria-label="チャネル一覧を閉じる"
              title="閉じる"
            >
              <Icon name="x" size="sm" />
            </button>
          )}
        </span>
      </div>

      <div className={styles.sidebarScroll}>
        {groups.map((g) => {
          const isCollapsed = !!collapsed[g.type];
          const isDm = g.type === "dm";
          return (
            <section key={g.type} className={styles.section}>
              <div className={styles.sectionHeader}>
                <button
                  type="button"
                  className={styles.sectionToggle}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(g.type)}
                >
                  <span className={`${styles.sectionChevron} ${isCollapsed ? styles.collapsed : ""}`} aria-hidden>
                    ▾
                  </span>
                  {g.label}
                </button>
                {canCreate && !isDm && (
                  <button type="button" className={styles.sectionAdd} onClick={onCreate} aria-label={`${g.label}を追加`} title="追加">
                    ＋
                  </button>
                )}
                {isDm && onNewDm && (
                  <button
                    type="button"
                    className={styles.sectionAdd}
                    onClick={onNewDm}
                    aria-label="ダイレクトメッセージを開始"
                    title="ダイレクトメッセージを開始"
                    data-testid="fe6-dm-new"
                  >
                    ＋
                  </button>
                )}
              </div>

              {!isCollapsed &&
                g.channels.map((c) => {
                  const u = unread[c.id];
                  const count = u?.unreadCount ?? 0;
                  const hasUnread = count > 0;
                  const mentioned = !!u?.mentioned;
                  const isActive = c.id === activeChannelId;
                  const label = labelOf(c);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`${styles.channelItem} ${isActive ? styles.active : ""} ${hasUnread ? styles.unread : ""}`}
                      onClick={() => onSelect(c.id)}
                      data-testid="fe6-channel-list-item"
                      data-channel-id={c.id}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <span className={styles.channelGlyph} aria-hidden>
                        {isDm ? (
                          <Dot p={getPresence(c.id)} />
                        ) : c.archived ? (
                          "🗄"
                        ) : c.visibility === "private" ? (
                          "🔒"
                        ) : (
                          "#"
                        )}
                      </span>
                      <span className={styles.channelName}>
                        {label ?? <Skeleton variant="text" width="6em" testId="fe6-channel-label-loading" />}
                      </span>
                      {mentioned ? (
                        <span className={styles.mentionBadge} data-testid="fe6-channel-unread-badge">
                          {count}
                        </span>
                      ) : hasUnread ? (
                        <span className={styles.countBadge} data-testid="fe6-channel-unread-badge">
                          {count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
            </section>
          );
        })}
      </div>
    </nav>
  );
}
