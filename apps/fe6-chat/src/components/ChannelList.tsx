// Sidebar channel list with grouping + unread badges (design §2-2). "New channel"
// button is gated by can("chat:create") upstream via `canCreate`.
import type { common } from "@dub/types";
import type { Channel } from "../api/contract";
import { groupChannels } from "../lib/channel-group";
import type { UnreadMap } from "../store/unread";
import styles from "../styles/chat.module.css";

export interface ChannelListProps {
  channels: Channel[];
  unread: UnreadMap;
  activeChannelId: common.ChannelId | null;
  canCreate: boolean;
  onSelect: (channelId: common.ChannelId) => void;
  onCreate?: () => void;
}

export function ChannelList({ channels, unread, activeChannelId, canCreate, onSelect, onCreate }: ChannelListProps) {
  const groups = groupChannels(channels);
  return (
    <nav className={styles.sidebar} aria-label="チャネル一覧" data-testid="fe6-channel-list">
      <div className={styles.sidebarHeader}>
        <span>チャット</span>
        {canCreate && (
          <button type="button" onClick={onCreate} data-testid="fe6-channel-create" aria-label="チャネルを作成">
            ＋
          </button>
        )}
      </div>
      {groups.map((g) => (
        <div key={g.type}>
          <div className={styles.channelGroupLabel}>{g.label}</div>
          {g.channels.map((c) => {
            const u = unread[c.id];
            const count = u?.unreadCount ?? 0;
            return (
              <button
                key={c.id}
                type="button"
                className={`${styles.channelItem} ${c.id === activeChannelId ? styles.active : ""}`}
                onClick={() => onSelect(c.id)}
                data-testid="fe6-channel-list-item"
                data-channel-id={c.id}
                aria-current={c.id === activeChannelId ? "page" : undefined}
              >
                <span>
                  {c.archived ? "🗄 " : "# "}
                  {c.name}
                </span>
                {count > 0 && (
                  <span className={`${styles.badge} ${u?.mentioned ? styles.mention : ""}`} data-testid="fe6-channel-unread-badge">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
