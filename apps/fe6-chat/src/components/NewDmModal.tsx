/// <reference lib="dom" />
// New-DM picker (Slack "新しいメッセージ"): search members by name, pick one (1:1)
// or several (group DM, up to DM_MAX_PEERS), then open the conversation. Picking
// the same people again lands in the existing DM — chat-service dedups by set.
import { useEffect, useState } from "react";
import { Avatar, Modal, SkeletonList } from "@dub/ui";
import type { common, identity } from "@dub/types";
import { useChatRuntime } from "../context";
import styles from "../styles/chat.module.css";

// Slack caps a group DM at 9 people (8 others + you); chat-service enforces the same.
export const DM_MAX_PEERS = 8;

export interface NewDmModalProps {
  open: boolean;
  onClose: () => void;
  onStart: (peers: identity.UserSummary[]) => Promise<void>;
}

export function NewDmModal({ open, onClose, onStart }: NewDmModalProps) {
  const { api, currentUserId } = useChatRuntime();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<identity.UserSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<identity.UserSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setResults(null);
    setFailed(false);
    const handle = globalThis.setTimeout(() => {
      api
        .searchUsers(query)
        .then((users) => !cancelled && setResults(users.filter((u) => u.id !== currentUserId)))
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setFailed(true);
        });
    }, 200);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(handle);
    };
  }, [api, currentUserId, open, query]);

  const reset = () => {
    setQuery("");
    setPicked([]);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const isPicked = (id: common.UserId) => picked.some((p) => p.id === id);
  const toggle = (u: identity.UserSummary) => {
    setError(null);
    setPicked((cur) => (cur.some((p) => p.id === u.id) ? cur.filter((p) => p.id !== u.id) : cur.length >= DM_MAX_PEERS ? cur : [...cur, u]));
  };

  const start = async () => {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(picked);
      reset();
      onClose();
    } catch {
      setError("DM を開始できませんでした。時間をおいてもう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  const full = picked.length >= DM_MAX_PEERS;
  return (
    <Modal open onClose={close} title="ダイレクトメッセージを開始" size="sm" testId="fe6-new-dm-modal">
      <div className={styles.createForm}>
        <label className={styles.createField}>
          <span className={styles.createLabel}>宛先</span>
          <input
            className={styles.createInput}
            value={query}
            autoFocus
            placeholder="名前で検索"
            aria-label="宛先を名前で検索"
            data-testid="fe6-new-dm-search"
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className={styles.createHint}>
            {full ? `一度に選べるのは ${DM_MAX_PEERS} 人までです` : "複数人を選ぶとグループ DM になります"}
          </span>
        </label>

        {picked.length > 0 && (
          <div className={styles.dmPicked} data-testid="fe6-new-dm-picked">
            {picked.map((u) => (
              <button
                key={u.id}
                type="button"
                className={styles.dmChip}
                onClick={() => toggle(u)}
                aria-label={`${u.displayName} を宛先から外す`}
              >
                {u.displayName} <span aria-hidden>×</span>
              </button>
            ))}
          </div>
        )}

        <div className={styles.dmResults} role="listbox" aria-label="メンバー" aria-multiselectable data-testid="fe6-new-dm-results">
          {results === null ? (
            <SkeletonList rows={4} avatar testId="fe6-new-dm-loading" />
          ) : results.length === 0 ? (
            <p className={styles.createHint}>{failed ? "メンバーを読み込めませんでした" : "該当するメンバーがいません"}</p>
          ) : (
            results.map((u) => {
              const on = isPicked(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={!on && full}
                  className={`${styles.dmResult} ${on ? styles.dmResultOn : ""}`}
                  onClick={() => toggle(u)}
                  data-testid="fe6-new-dm-option"
                >
                  <Avatar name={u.displayName} src={u.avatarUrl ?? undefined} size="sm" />
                  <span className={styles.dmResultName}>{u.displayName}</span>
                  <span className={styles.dmResultCheck} aria-hidden>
                    {on ? "✓" : ""}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {error && (
          <p className={styles.dmError} role="alert">
            {error}
          </p>
        )}

        <div className={styles.createActions}>
          <button type="button" className={styles.editCancel} onClick={close}>
            キャンセル
          </button>
          <button
            type="button"
            className={styles.sendButton}
            disabled={picked.length === 0 || busy}
            data-testid="fe6-new-dm-start"
            onClick={() => void start()}
          >
            {picked.length > 1 ? `${picked.length + 1} 人で開始` : "開始"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
