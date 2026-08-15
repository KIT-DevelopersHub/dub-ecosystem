/// <reference lib="dom" />
// Create-channel modal (Slack "Create a channel"): name, optional topic, and a
// public/private visibility toggle. Name is normalized to a slug-ish handle.
import { useState } from "react";
import { Modal } from "@dub/ui";
import type { CreateChannelRequest } from "../api/contract";
import styles from "../styles/chat.module.css";

export interface CreateChannelModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (req: CreateChannelRequest) => void | Promise<void>;
}

function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_ぁ-んァ-ヶー一-龠]/g, "")
    .slice(0, 80);
}

export function CreateChannelModal({ open, onClose, onCreate }: CreateChannelModalProps) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [busy, setBusy] = useState(false);
  const handle = normalizeName(name);
  const valid = handle.length > 0;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onCreate({ type: "topic", visibility, name: handle, topic: topic.trim() || undefined });
      setName("");
      setTopic("");
      setVisibility("public");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Modal open onClose={onClose} title="チャンネルを作成" size="sm" testId="fe6-create-channel-modal">
      <div className={styles.createForm}>
        <label className={styles.createField}>
          <span className={styles.createLabel}>名前</span>
          <div className={styles.createNameWrap}>
            <span className={styles.createHash} aria-hidden>
              {visibility === "private" ? "🔒" : "#"}
            </span>
            <input
              className={styles.createInput}
              value={name}
              autoFocus
              placeholder="例: プロジェクト-x"
              aria-label="チャンネル名"
              data-testid="fe6-create-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>
          {name && <span className={styles.createHint}>作成されるチャンネル: #{handle}</span>}
        </label>

        <label className={styles.createField}>
          <span className={styles.createLabel}>説明 (任意)</span>
          <input
            className={styles.createInput}
            value={topic}
            placeholder="このチャンネルは何のため？"
            aria-label="説明"
            data-testid="fe6-create-topic"
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>

        <div className={styles.createField}>
          <span className={styles.createLabel}>公開範囲</span>
          <label className={styles.createRadio}>
            <input
              type="radio"
              name="visibility"
              checked={visibility === "public"}
              onChange={() => setVisibility("public")}
            />
            <span>
              <strong># 公開</strong> — 誰でも参加・閲覧できます
            </span>
          </label>
          <label className={styles.createRadio}>
            <input
              type="radio"
              name="visibility"
              checked={visibility === "private"}
              data-testid="fe6-create-private"
              onChange={() => setVisibility("private")}
            />
            <span>
              <strong>🔒 非公開</strong> — 招待されたメンバーのみ
            </span>
          </label>
        </div>

        <div className={styles.createActions}>
          <button type="button" className={styles.editCancel} onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className={styles.sendButton}
            disabled={!valid || busy}
            data-testid="fe6-create-submit"
            onClick={() => void submit()}
          >
            作成
          </button>
        </div>
      </div>
    </Modal>
  );
}
