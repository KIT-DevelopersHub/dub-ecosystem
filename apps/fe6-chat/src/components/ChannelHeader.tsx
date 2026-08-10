// Channel top bar: #name (opens settings when moderator), topic, member count,
// in-channel search, and thread/pin affordances. Slack-style layout via @dub/ui.
import type { Channel } from "../api/contract";
import styles from "../styles/chat.module.css";

export function ChannelHeader({
  channel,
  canModerate,
  onOpenSettings,
}: {
  channel: Channel;
  canModerate: boolean;
  onOpenSettings?: () => void;
}) {
  const isDm = channel.type === "dm";
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
        <button type="button" className={styles.memberChip} title="メンバー">
          <span aria-hidden>👥</span>
          <span>{channel.memberCount}</span>
        </button>
        <label className={styles.searchBox}>
          <span aria-hidden>🔍</span>
          <input type="search" placeholder={`#${channel.name} を検索`} aria-label="チャンネル内を検索" />
        </label>
        <button type="button" className={styles.iconBtn} aria-label="ピン留め" title="ピン留め">
          📌
        </button>
        <button type="button" className={styles.iconBtn} aria-label="その他" title="その他">
          ⋯
        </button>
      </div>
    </header>
  );
}
