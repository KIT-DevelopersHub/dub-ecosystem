// Read receipt (既読) shown under the current user's newest read message. Subscribes
// to the read-receipt store (fed by the RT read-state fanout in production, by the
// demo simulator otherwise) and renders, LINE-style, a single marker on the latest of
// the user's own messages that other members have read: "既読" (DM) or "既読 N"
// (channel, with up to three reader avatars). Renders nothing until someone has read.
import { useMemo } from "react";
import type { common, identity } from "@dub/types";
import { Avatar } from "@dub/ui";
import type { ChannelType, Message } from "../api/contract";
import { getReadersOf } from "../lib/read-receipts";
import { useReceiptsVersion } from "../hooks/useChatLive";
import styles from "../styles/chat.module.css";

export interface ReadReceiptsProps {
  channelId: common.ChannelId;
  channelType: ChannelType;
  currentUserId: common.UserId;
  messages: Message[];
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
}

export function ReadReceipts({ channelId, channelType, currentUserId, messages, resolveUser }: ReadReceiptsProps) {
  const version = useReceiptsVersion(channelId); // re-render when a watermark advances

  const receipt = useMemo(() => {
    // newest own (non-deleted) message that at least one other member has read
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.authorId !== currentUserId || m.deletedAt) continue;
      const readers = getReadersOf(channelId, m.id, [currentUserId]);
      if (readers.length > 0) return { messageId: m.id, readers };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, currentUserId, messages, version]);

  if (!receipt) return null;

  return (
    <div className={styles.readReceipt} data-testid="fe6-read-receipt" data-message-id={receipt.messageId}>
      {channelType !== "dm" && (
        <span className={styles.readReceiptAvatars} aria-hidden>
          {receipt.readers.slice(0, 3).map((id) => (
            <Avatar key={id} name={resolveUser?.(id)?.displayName ?? id} src={resolveUser?.(id)?.avatarUrl ?? undefined} size="sm" />
          ))}
        </span>
      )}
      <span className={styles.readReceiptLabel}>
        {channelType === "dm" ? "既読" : `既読 ${receipt.readers.length}`}
      </span>
    </div>
  );
}
