// Channel settings + member management (design §2-2, admin only). Archive is a
// destructive toggle -> confirmed. Optimistic-lock version is carried on save.
// Delete (chat:delete_channel) is a separate, irreversible action shown only when
// `onDelete` is passed; `canEdit=false` leaves just that section (delete-only role).
import { useState } from "react";
import { ConfirmDialog } from "@dub/ui";
import type { common } from "@dub/types";
import type { Channel } from "../api/contract";
import styles from "../styles/chat.module.css";

export interface ChannelSettingsFormProps {
  channel: Channel;
  onSave: (patch: { name: string; topic: string | null; version: number }) => void | Promise<void>;
  onArchiveToggle: (archived: boolean, version: number) => void | Promise<void>;
  onAddMember?: (userId: common.UserId) => void;
  onRemoveMember?: (userId: common.UserId) => void;
  /** Hard delete. Omit to hide the button (no chat:delete_channel / DM). */
  onDelete?: () => Promise<void>;
  /** false = no moderate rights: hide name/topic/archive, keep delete. Default true. */
  canEdit?: boolean;
}

export function ChannelSettingsForm({ channel, onSave, onArchiveToggle, onDelete, canEdit = true }: ChannelSettingsFormProps) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  return (
    <form
      className={styles.main}
      data-testid="fe6-channel-settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ name, topic: topic.length ? topic : null, version: channel.version });
      }}
      style={{ padding: "16px", gap: "8px" }}
    >
      {canEdit && (
        <>
      <label>
        名称
        <input value={name} onChange={(e) => setName(e.target.value)} data-testid="fe6-settings-name" />
      </label>
      <label>
        トピック
        <input value={topic} onChange={(e) => setTopic(e.target.value)} data-testid="fe6-settings-topic" />
      </label>
      <div>
        <button type="submit" className={styles.sendButton} data-testid="fe6-settings-save">
          保存
        </button>
        <button
          type="button"
          data-testid="fe6-settings-archive"
          onClick={() => setArchiveConfirmOpen(true)}
        >
          {channel.archived ? "アーカイブ解除" : "アーカイブ"}
        </button>
      </div>
        </>
      )}
      {onDelete && (
        <div className={styles.settingsDanger}>
          <div className={styles.settingsDangerText}>
            <strong>チャンネルを削除</strong>
            <span>メッセージもすべて完全に削除され、元に戻せません。残しておきたい場合はアーカイブを使ってください。</span>
          </div>
          <button
            type="button"
            className={styles.dangerButton}
            data-testid="fe6-settings-delete"
            onClick={() => setDeleteConfirmOpen(true)}
          >
            チャンネルを削除
          </button>
        </div>
      )}
      <ConfirmDialog
        open={archiveConfirmOpen}
        title={channel.archived ? "アーカイブを解除しますか？" : "チャネルをアーカイブしますか？"}
        message={
          channel.archived
            ? "このチャネルをアクティブに戻します。"
            : "アーカイブすると一覧から隠れ、投稿できなくなります。"
        }
        confirmLabel={channel.archived ? "解除する" : "アーカイブする"}
        danger={!channel.archived}
        onConfirm={() => {
          setArchiveConfirmOpen(false);
          void onArchiveToggle(!channel.archived, channel.version);
        }}
        onCancel={() => setArchiveConfirmOpen(false)}
        testId="fe6-settings-archive-confirm"
      />
      {onDelete && (
        <ConfirmDialog
          open={deleteConfirmOpen}
          title={`#${channel.name} を削除しますか？`}
          message="チャンネルとすべてのメッセージが完全に削除され、元に戻すことはできません。アーカイブと違い、あとから閲覧・復元することもできなくなります。"
          confirmLabel="完全に削除する"
          danger
          onConfirm={async () => {
            // Dialog shows its own pending state; the caller reports failure (toast).
            await onDelete().catch(() => undefined);
            setDeleteConfirmOpen(false);
          }}
          onCancel={() => setDeleteConfirmOpen(false)}
          testId="fe6-settings-delete-confirm"
        />
      )}
    </form>
  );
}
