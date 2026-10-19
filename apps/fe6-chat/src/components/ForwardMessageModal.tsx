/// <reference lib="dom" />
// 「メッセージを転送」: pick a channel/DM, add an optional comment, and the message is
// re-posted there as a quote with its author and source channel. Same form idiom as
// CreateChannelModal.
import { useState } from "react";
import { Modal } from "@dub/ui";
import type { common } from "@dub/types";
import { buildForwardBody } from "../lib/forward";
import styles from "../styles/chat.module.css";

export interface ForwardMessageModalProps {
  sourceChannelName: string;
  channels: { id: common.ChannelId; label: string; archived: boolean }[];
  authorName: string;
  /** Message body with mentions flattened to names (also what gets quoted). */
  preview: string;
  /** Attachments aren't re-posted (no copy API yet) — say so instead of dropping them silently. */
  hasAttachments?: boolean;
  onClose: () => void;
  onForward: (channelId: common.ChannelId, body: string) => Promise<void>;
}

export function ForwardMessageModal({
  sourceChannelName,
  channels,
  authorName,
  preview,
  hasAttachments = false,
  onClose,
  onForward,
}: ForwardMessageModalProps) {
  const targets = channels.filter((c) => !c.archived);
  const [target, setTarget] = useState<common.ChannelId | "">("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await onForward(target, buildForwardBody({ comment, text: preview, authorName, sourceChannelName }));
      onClose();
    } catch {
      // the caller toasts the reason; keep the dialog open for a retry
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="メッセージを転送する" size="sm" testId="fe6-forward-modal">
      <div className={styles.forwardForm}>
        <label className={styles.createField}>
          <span className={styles.createLabel}>転送先</span>
          <select
            className={styles.createInput}
            value={target}
            aria-label="転送先"
            data-testid="fe6-forward-target"
            onChange={(e) => setTarget(e.target.value as common.ChannelId)}
          >
            <option value="">チャンネルまたは DM を選択</option>
            {targets.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.createField}>
          <span className={styles.createLabel}>メッセージを追加 (任意)</span>
          <textarea
            className={styles.editTextarea}
            value={comment}
            rows={3}
            aria-label="メッセージを追加"
            data-testid="fe6-forward-comment"
            onChange={(e) => setComment(e.target.value)}
          />
        </label>

        <div className={styles.forwardPreview} data-testid="fe6-forward-preview">
          <span className={styles.forwardPreviewAuthor}>
            {authorName} · {sourceChannelName}
          </span>
          {preview || "(添付ファイル)"}
        </div>
        {hasAttachments && <span className={styles.createHint}>添付ファイルは転送されません (本文のみ転送します)</span>}

        <div className={styles.createActions}>
          <button type="button" className={styles.editCancel} onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className={styles.sendButton}
            disabled={!target || busy}
            data-testid="fe6-forward-submit"
            onClick={() => void submit()}
          >
            転送する
          </button>
        </div>
      </div>
    </Modal>
  );
}
