// Channel settings + member management (design §2-2, admin only). Archive is a
// destructive toggle -> confirmed. Optimistic-lock version is carried on save.
import { useState } from "react";
import type { common } from "@dub/types";
import type { Channel } from "../api/contract";
import styles from "../styles/chat.module.css";

export interface ChannelSettingsFormProps {
  channel: Channel;
  onSave: (patch: { name: string; topic: string | null; version: number }) => void | Promise<void>;
  onArchiveToggle: (archived: boolean, version: number) => void | Promise<void>;
  onAddMember?: (userId: common.UserId) => void;
  onRemoveMember?: (userId: common.UserId) => void;
}

export function ChannelSettingsForm({ channel, onSave, onArchiveToggle }: ChannelSettingsFormProps) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");

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
          onClick={() => {
            if (globalThis.confirm?.(channel.archived ? "アーカイブを解除しますか？" : "このチャネルをアーカイブしますか？")) {
              void onArchiveToggle(!channel.archived, channel.version);
            }
          }}
        >
          {channel.archived ? "アーカイブ解除" : "アーカイブ"}
        </button>
      </div>
    </form>
  );
}
