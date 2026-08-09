/// <reference lib="dom" />
// Message input: Markdown subset, <@userId> mention autocomplete, draft
// persistence (sessionStorage), empty-body guard, disabled when archived (design
// §2-2, §7). Attachment selection is a fileId hand-off (upload lives in file-meta).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { identity } from "@dub/types";
import type { common } from "@dub/types";
import { applyMention, detectMentionTrigger } from "../lib/mentions";
import { clearDraft, DRAFT_MAX_LEN, loadDraft, saveDraft } from "../store/draft";
import styles from "../styles/chat.module.css";

export interface MessageComposerProps {
  channelId: common.ChannelId;
  disabled?: boolean;
  disabledReason?: string;
  error?: string | null;
  // resolves mention candidates for the current query (identity roster)
  resolveMentionCandidates?: (query: string) => identity.UserSummary[];
  onSend: (body: string) => void | Promise<void>;
}

export function MessageComposer({
  channelId,
  disabled = false,
  disabledReason,
  error,
  resolveMentionCandidates,
  onSend,
}: MessageComposerProps) {
  const [text, setText] = useState<string>(() => loadDraft(channelId));
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  // reload draft when switching channels
  useEffect(() => {
    setText(loadDraft(channelId));
  }, [channelId]);

  // persist draft (truncated) on every change
  useEffect(() => {
    saveDraft(channelId, text);
  }, [channelId, text]);

  const trigger = useMemo(() => detectMentionTrigger(text, caret), [text, caret]);
  const candidates = useMemo(
    () => (trigger && resolveMentionCandidates ? resolveMentionCandidates(trigger.query) : []),
    [trigger, resolveMentionCandidates],
  );

  const canSend = text.trim().length > 0 && !disabled;

  const pickMention = useCallback(
    (user: identity.UserSummary) => {
      if (!trigger) return;
      const next = applyMention(text, caret, trigger, user.id);
      setText(next.text);
      setCaret(next.caret);
      setSelected(0);
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el) {
          el.focus();
          el.setSelectionRange(next.caret, next.caret);
        }
      });
    },
    [trigger, text, caret],
  );

  const submit = useCallback(async () => {
    if (!canSend) return;
    const body = text;
    setText("");
    clearDraft(channelId);
    await onSend(body);
  }, [canSend, text, channelId, onSend]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => (s + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => (s - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const pick = candidates[selected];
        if (pick) pickMention(pick);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className={styles.composer}>
      {candidates.length > 0 && (
        <ul className={styles.mentionMenu} role="listbox" data-testid="fe6-composer-mention-menu">
          {candidates.map((u, i) => (
            <li key={u.id} role="option" aria-selected={i === selected}>
              <button type="button" aria-selected={i === selected} onClick={() => pickMention(u)}>
                {u.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        value={text}
        disabled={disabled}
        maxLength={DRAFT_MAX_LEN}
        placeholder={disabled ? disabledReason ?? "投稿できません" : "メッセージを入力（Enterで送信 / Shift+Enterで改行）"}
        aria-label="メッセージ入力"
        data-testid="fe6-composer-input"
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      {error && (
        <div className={styles.composerError} role="alert" data-testid="fe6-composer-error">
          {error}
        </div>
      )}
      <button
        type="button"
        className={styles.sendButton}
        disabled={!canSend}
        data-testid="fe6-composer-send"
        onClick={() => void submit()}
      >
        送信
      </button>
    </div>
  );
}
