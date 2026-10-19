/// <reference lib="dom" />
// 「メッセージを転送する」 (Slack): 宛先 (search a channel / DM) → optional message →
// preview of the card the recipients will see. The message is re-posted there as a
// quote with its author, source channel and a link back (rendered as ForwardedCard).
import { useMemo, useState } from "react";
import { Modal } from "@dub/ui";
import type { common } from "@dub/types";
import { buildForwardBody } from "../lib/forward";
import { QuoteCard } from "./MessageUnfurl";
import styles from "../styles/chat.module.css";

const MAX_TARGET_RESULTS = 6;

export interface ForwardMessageModalProps {
  sourceChannelName: string;
  channels: { id: common.ChannelId; label: string; archived: boolean }[];
  authorName: string;
  /** Message body with mentions flattened to names (also what gets quoted). */
  preview: string;
  /** Attachments aren't re-posted (no copy API yet) — say so instead of dropping them silently. */
  hasAttachments?: boolean;
  /** Permalink of the original (the card's 「メッセージを表示」). */
  link?: string;
  onClose: () => void;
  onForward: (channelId: common.ChannelId, body: string) => Promise<void>;
}

export function ForwardMessageModal({
  sourceChannelName,
  channels,
  authorName,
  preview,
  hasAttachments = false,
  link,
  onClose,
  onForward,
}: ForwardMessageModalProps) {
  const targets = useMemo(() => channels.filter((c) => !c.archived), [channels]);
  const [target, setTarget] = useState<common.ChannelId | null>(null);
  const [query, setQuery] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const picked = targets.find((c) => c.id === target) ?? null;
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const results = targets.filter((c) => c.label.toLowerCase().replace(/^#/, "").includes(q)).slice(0, MAX_TARGET_RESULTS);

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await onForward(target, buildForwardBody({ comment, text: preview, authorName, sourceChannelName, ...(link ? { link } : {}) }));
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
        <div className={styles.createField}>
          <span className={styles.createLabel} id="fe6-forward-to">
            宛先
          </span>
          {picked ? (
            <div className={styles.dmPicked}>
              <button
                type="button"
                className={styles.dmChip}
                aria-label={`${picked.label} を宛先から外す`}
                data-testid="fe6-forward-picked"
                onClick={() => setTarget(null)}
              >
                {picked.label} ✕
              </button>
            </div>
          ) : (
            <>
              <input
                className={styles.createInput}
                value={query}
                autoFocus
                placeholder="チャンネル名または DM の相手を入力"
                aria-labelledby="fe6-forward-to"
                data-testid="fe6-forward-target"
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className={styles.dmResults} role="listbox" aria-label="転送先" data-testid="fe6-forward-results">
                {results.length === 0 ? (
                  <span className={styles.createHint}>該当するチャンネルや DM がありません</span>
                ) : (
                  results.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      className={styles.dmResult}
                      data-testid="fe6-forward-option"
                      onClick={() => {
                        setTarget(c.id);
                        setQuery("");
                      }}
                    >
                      <span className={styles.dmResultName}>{c.label}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <label className={styles.createField}>
          <span className={styles.createLabel}>メッセージを追加 (任意)</span>
          <textarea
            className={styles.editTextarea}
            value={comment}
            rows={3}
            placeholder="メッセージを追加…"
            aria-label="メッセージを追加"
            data-testid="fe6-forward-comment"
            onChange={(e) => setComment(e.target.value)}
          />
        </label>

        <div data-testid="fe6-forward-preview">
          <QuoteCard authorName={authorName} footer={`${sourceChannelName} に投稿`} testId="fe6-forward-preview-card">
            {preview || "(添付ファイル)"}
          </QuoteCard>
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
