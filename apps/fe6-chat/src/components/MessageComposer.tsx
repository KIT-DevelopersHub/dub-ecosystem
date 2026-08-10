/// <reference lib="dom" />
// Rich message composer: formatting toolbar (bold / italic / code / code-block /
// link / emoji / mention / attach), Markdown-subset body, <@userId> mention
// autocomplete, sessionStorage draft persistence, empty-body guard, archived
// disable (design §2-2, §7). Attachment is a fileId hand-off (upload lives in
// file-meta) — here it is a stubbed affordance. Test-ids preserved for units.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { identity } from "@dub/types";
import type { common } from "@dub/types";
import { applyMention, detectMentionTrigger } from "../lib/mentions";
import { clearDraft, DRAFT_MAX_LEN, loadDraft, saveDraft } from "../store/draft";
import styles from "../styles/chat.module.css";

export interface MessageComposerProps {
  channelId: common.ChannelId;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  error?: string | null;
  resolveMentionCandidates?: (query: string) => identity.UserSummary[];
  onSend: (body: string) => void | Promise<void>;
}

const EMOJIS = ["😀", "😅", "🎉", "👍", "🙏", "🔥", "✅", "👀", "❤️", "🚀"];

export function MessageComposer({
  channelId,
  placeholder,
  disabled = false,
  disabledReason,
  error,
  resolveMentionCandidates,
  onSend,
}: MessageComposerProps) {
  const [text, setText] = useState<string>(() => loadDraft(channelId));
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(loadDraft(channelId));
  }, [channelId]);

  useEffect(() => {
    saveDraft(channelId, text);
  }, [channelId, text]);

  const trigger = useMemo(() => detectMentionTrigger(text, caret), [text, caret]);
  const candidates = useMemo(
    () => (trigger && resolveMentionCandidates ? resolveMentionCandidates(trigger.query) : []),
    [trigger, resolveMentionCandidates],
  );

  const canSend = text.trim().length > 0 && !disabled;

  const focusCaret = useCallback((pos: number) => {
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      }
    });
  }, []);

  const pickMention = useCallback(
    (user: identity.UserSummary) => {
      if (!trigger) return;
      const next = applyMention(text, caret, trigger, user.id);
      setText(next.text);
      setSelected(0);
      focusCaret(next.caret);
    },
    [trigger, text, caret, focusCaret],
  );

  /** Wrap the current selection (or caret) with prefix/suffix. */
  const wrapSelection = useCallback(
    (prefix: string, suffix: string = prefix, block = false) => {
      const el = ref.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? text.length;
      const sel = text.slice(start, end);
      const glue = block ? "\n" : "";
      const inserted = `${prefix}${glue}${sel}${glue}${suffix}`;
      const next = text.slice(0, start) + inserted + text.slice(end);
      setText(next);
      focusCaret(start + prefix.length + glue.length + (sel.length || 0));
    },
    [text, focusCaret],
  );

  const insertAt = useCallback(
    (str: string) => {
      const el = ref.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? text.length;
      const next = text.slice(0, start) + str + text.slice(end);
      setText(next);
      focusCaret(start + str.length);
    },
    [text, focusCaret],
  );

  const submit = useCallback(async () => {
    if (!canSend) return;
    const body = text;
    setText("");
    setEmojiOpen(false);
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

      {emojiOpen && !disabled && (
        <ul className={styles.mentionMenu} role="listbox" aria-label="絵文字">
          {EMOJIS.map((e) => (
            <li key={e} role="option">
              <button
                type="button"
                onClick={() => {
                  insertAt(e);
                  setEmojiOpen(false);
                }}
              >
                {e}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.composerBox}>
        <div className={styles.toolbar} role="toolbar" aria-label="書式">
          <button type="button" className={`${styles.toolbarBtn} ${styles.bold}`} aria-label="太字" title="太字" disabled={disabled} onClick={() => wrapSelection("*")}>
            B
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.italic}`} aria-label="斜体" title="斜体" disabled={disabled} onClick={() => wrapSelection("_")}>
            i
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.codeGlyph}`} aria-label="コード" title="インラインコード" disabled={disabled} onClick={() => wrapSelection("`")}>
            {"</>"}
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.codeGlyph}`} aria-label="コードブロック" title="コードブロック" disabled={disabled} onClick={() => wrapSelection("```", "```", true)}>
            {"{ }"}
          </button>
          <span className={styles.toolbarDivider} aria-hidden />
          <button type="button" className={styles.toolbarBtn} aria-label="リンク" title="リンク" disabled={disabled} onClick={() => wrapSelection("[", "](url)")}>
            🔗
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="絵文字" title="絵文字" disabled={disabled} onClick={() => setEmojiOpen((o) => !o)}>
            😊
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="メンション" title="メンション" disabled={disabled} onClick={() => insertAt("@")}>
            @
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="添付" title="ファイルを添付" disabled={disabled}>
            📎
          </button>
        </div>

        <textarea
          ref={ref}
          value={text}
          disabled={disabled}
          rows={1}
          maxLength={DRAFT_MAX_LEN}
          placeholder={disabled ? disabledReason ?? "投稿できません" : placeholder ?? "メッセージを入力"}
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

        <div className={styles.composerBottom}>
          <div className={styles.composerHints} aria-hidden />
          <button type="button" className={styles.sendButton} disabled={!canSend} data-testid="fe6-composer-send" onClick={() => void submit()}>
            <span aria-hidden>➤</span> 送信
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.composerError} role="alert" data-testid="fe6-composer-error">
          {error}
        </div>
      )}
      <div className={styles.composerHelp}>Enter で送信 · Shift+Enter で改行 · @ でメンション</div>
    </div>
  );
}
