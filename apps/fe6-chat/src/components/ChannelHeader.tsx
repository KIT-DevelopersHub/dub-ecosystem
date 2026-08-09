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
  return (
    <header className={styles.header} data-testid="fe6-channel-header">
      <div>
        <div className={styles.headerTitle}># {channel.name}</div>
        {channel.topic && <div className={styles.headerTopic}>{channel.topic}</div>}
      </div>
      <div className={styles.headerTopic}>
        <span>{channel.memberCount} 人</span>
        {canModerate && (
          <button type="button" onClick={onOpenSettings} data-testid="fe6-channel-settings-open">
            設定
          </button>
        )}
      </div>
    </header>
  );
}
