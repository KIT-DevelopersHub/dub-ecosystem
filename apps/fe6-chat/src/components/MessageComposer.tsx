/// <reference lib="dom" />
// Rich message composer: formatting toolbar (bold / italic / code / code-block /
// link / emoji / mention / attach), Markdown-subset body, <@userId> mention
// autocomplete, sessionStorage draft persistence, empty-body guard, archived
// disable (design §2-2, §7). Attachment is a fileId hand-off (upload lives in
// file-meta) — here it is a stubbed affordance. Test-ids preserved for units.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, isImeComposing } from "@dub/ui";
import type { identity } from "@dub/types";
import type { common } from "@dub/types";
import { applyMention, detectMentionTrigger } from "../lib/mentions";
import { clearDraft, DRAFT_MAX_LEN, loadDraft, saveDraft } from "../store/draft";
import { newFileId } from "../lib/ulid";
import type { Attachment } from "../api/contract";
import styles from "../styles/chat.module.css";

export interface MessageComposerProps {
  channelId: common.ChannelId;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  error?: string | null;
  resolveMentionCandidates?: (query: string) => identity.UserSummary[];
  onSend: (body: string, attachments?: Attachment[]) => void | Promise<void>;
}

const MAX_ATTACH_BYTES = 5 * 1024 * 1024; // 5MB per file (demo guard)

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Tracks IME composition so the 変換確定 Enter never triggers submit / mention pick /
  // menu nav. Backs up isImeComposing() for browsers whose confirm keydown reports
  // isComposing=false right before compositionend.
  const composingRef = useRef(false);

  useEffect(() => {
    // reset attachments when switching channels (drafts persist; files don't)
    setAttachments([]);
    setAttachError(null);
  }, [channelId]);

  const onFilesPicked = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachError(null);
    const picked: Attachment[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACH_BYTES) {
        setAttachError(`${file.name} は 5MB を超えています`);
        continue;
      }
      const url = await readAsDataUrl(file);
      picked.push({ fileId: newFileId(), name: file.name, mime: file.type || "application/octet-stream", size: file.size, url });
    }
    if (picked.length > 0) setAttachments((prev) => [...prev, ...picked]);
  }, []);

  const removeAttachment = useCallback((fileId: string) => {
    setAttachments((prev) => prev.filter((a) => a.fileId !== fileId));
  }, []);

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

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled;

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

  /** Prefix each line touched by the selection (blockquote / bullet / ordered list). */
  const prefixLines = useCallback(
    (prefix: (lineIndex: number) => string) => {
      const el = ref.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? text.length;
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = text.indexOf("\n", end);
      const blockEnd = lineEnd === -1 ? text.length : lineEnd;
      const block = text.slice(lineStart, blockEnd);
      const prefixed = block
        .split("\n")
        .map((ln, i) => `${prefix(i)}${ln}`)
        .join("\n");
      const next = text.slice(0, lineStart) + prefixed + text.slice(blockEnd);
      setText(next);
      focusCaret(lineStart + prefixed.length);
    },
    [text, focusCaret],
  );

  const submit = useCallback(async () => {
    if (!canSend) return;
    const body = text;
    const files = attachments;
    setText("");
    setAttachments([]);
    setAttachError(null);
    setEmojiOpen(false);
    clearDraft(channelId);
    await onSend(body, files.length > 0 ? files : undefined);
  }, [canSend, text, attachments, channelId, onSend]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 変換確定 Enter (and any keydown mid-composition) must never submit, pick a
    // mention, or drive menu nav — let the IME own it.
    if (composingRef.current || isImeComposing(e)) return;
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
    // Formatting shortcuts (Slack-style): Cmd/Ctrl + B / I / U / Shift+X (strike).
    if (e.metaKey || e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "b") {
        e.preventDefault();
        wrapSelection("*");
        return;
      }
      if (k === "i") {
        e.preventDefault();
        wrapSelection("_");
        return;
      }
      if (k === "u") {
        e.preventDefault();
        wrapSelection("++");
        return;
      }
      if (e.shiftKey && k === "x") {
        e.preventDefault();
        wrapSelection("~");
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
            <Icon name="bold" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.italic}`} aria-label="斜体" title="斜体 (Cmd+I)" disabled={disabled} onClick={() => wrapSelection("_")}>
            <Icon name="italic" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.underlineGlyph}`} aria-label="下線" title="下線 (Cmd+U)" disabled={disabled} onClick={() => wrapSelection("++")}>
            <Icon name="underline" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.strikeGlyph}`} aria-label="取り消し線" title="取り消し線 (Cmd+Shift+X)" disabled={disabled} onClick={() => wrapSelection("~")}>
            <Icon name="strikethrough" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.codeGlyph}`} aria-label="コード" title="インラインコード" disabled={disabled} onClick={() => wrapSelection("`")}>
            <Icon name="code" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.codeGlyph}`} aria-label="コードブロック" title="コードブロック" disabled={disabled} onClick={() => wrapSelection("```", "```", true)}>
            <Icon name="code-block" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="引用" title="引用" disabled={disabled} onClick={() => prefixLines(() => "> ")}>
            <Icon name="quote" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="箇条書き" title="箇条書き" disabled={disabled} onClick={() => prefixLines(() => "- ")}>
            <Icon name="list" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="番号付きリスト" title="番号付きリスト" disabled={disabled} onClick={() => prefixLines((i) => `${i + 1}. `)}>
            <Icon name="list-ordered" size="sm" />
          </button>
          <span className={styles.toolbarDivider} aria-hidden />
          <button type="button" className={styles.toolbarBtn} aria-label="リンク" title="リンク" disabled={disabled} onClick={() => wrapSelection("[", "](url)")}>
            <Icon name="link" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="絵文字" title="絵文字" disabled={disabled} onClick={() => setEmojiOpen((o) => !o)}>
            <Icon name="smile" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="メンション" title="メンション" disabled={disabled} onClick={() => insertAt("@")}>
            <Icon name="at-sign" size="sm" />
          </button>
          <button
            type="button"
            className={styles.toolbarBtn}
            aria-label="添付"
            title="ファイルを添付"
            disabled={disabled}
            data-testid="fe6-composer-attach"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="paperclip" size="sm" />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            aria-hidden
            data-testid="fe6-composer-file-input"
            onChange={(e) => {
              void onFilesPicked(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {attachments.length > 0 && (
          <div className={styles.attachTray} data-testid="fe6-composer-attach-tray">
            {attachments.map((a) => (
              <div key={a.fileId} className={styles.attachChip}>
                {a.url && a.mime.startsWith("image/") ? (
                  <img src={a.url} alt={a.name} className={styles.attachChipThumb} />
                ) : (
                  <span className={styles.attachChipGlyph} aria-hidden>
                    📄
                  </span>
                )}
                <span className={styles.attachChipName}>{a.name}</span>
                <button
                  type="button"
                  className={styles.attachChipRemove}
                  aria-label={`${a.name} を削除`}
                  onClick={() => removeAttachment(a.fileId)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

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
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />

        <div className={styles.composerBottom}>
          <div className={styles.composerHints} aria-hidden />
          <button type="button" className={styles.sendButton} disabled={!canSend} data-testid="fe6-composer-send" onClick={() => void submit()}>
            <Icon name="send" size="sm" /> 送信
          </button>
        </div>
      </div>

      {(error || attachError) && (
        <div className={styles.composerError} role="alert" data-testid="fe6-composer-error">
          {error ?? attachError}
        </div>
      )}
      <div className={styles.composerHelp}>Enter で送信 · Shift+Enter で改行 · @ でメンション</div>
    </div>
  );
}
