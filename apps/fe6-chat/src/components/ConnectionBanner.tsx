// RT connection state banner (design §2-2). Viewing/posting continue over HTTP
// even while disconnected — this only informs the user of the RT status.
import type { RealtimeStatus } from "../realtime/client";
import styles from "../styles/chat.module.css";

export function ConnectionBanner({ status, archived }: { status: RealtimeStatus; archived?: boolean }) {
  if (archived) {
    return (
      <div className={`${styles.banner} ${styles.archived}`} role="status" data-testid="fe6-channel-archived-banner">
        アーカイブ済みチャネルです（閲覧のみ）
      </div>
    );
  }
  if (status === "open" || status === "connecting") return null;
  return (
    <div className={styles.banner} role="status" data-testid="fe6-channel-connection-banner">
      {status === "reconnecting" ? "再接続中… 新着はポーリングで取得します" : "リアルタイム接続が切断されました"}
    </div>
  );
}
