/// <reference lib="dom" />
// Rich message composer: formatting toolbar (bold / italic / code / code-block /
// link / emoji / mention / attach), mention autocomplete for both people (<@userId>)
// and 運営チーム (<!team:teamId>), sessionStorage draft persistence, empty-body guard,
// archived disable (design §2-2, §7). Attachment is a fileId hand-off (upload lives
// in file-meta) — here it is a stubbed affordance. Test-ids preserved for units.
//
// The input is a WYSIWYG contentEditable (Slack parity): bold shows as bold while
// typing, mentions as chips. The body sent / saved as draft is still the Markdown
// subset — lib/composer-editor.ts converts between the two.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, isImeComposing } from "@dub/ui";
import type { common } from "@dub/types";
import { detectMentionTrigger, mentionToken, type MentionCandidate } from "../lib/mentions";
import {
  applyInputRules,
  caretToEnd,
  ensureLines,
  insertLink,
  insertText,
  mentionChip,
  placeCaret,
  rangeIn,
  renderEditor,
  replaceBeforeCaret,
  serializeEditor,
  splitLine,
  textBeforeCaret,
  toggleInlineCode,
  toggleLineBlock,
  unblockAtLineStart,
  type LineBlock,
  type MentionLabels,
} from "../lib/composer-editor";
import { clearDraft, DRAFT_MAX_LEN, loadDraft, saveDraft } from "../store/draft";
import { newFileId } from "../lib/ulid";
import type { Attachment } from "../api/contract";
import type { MentionResolvers } from "./MessageBody";
import styles from "../styles/chat.module.css";

export interface MessageComposerProps extends MentionResolvers {
  channelId: common.ChannelId;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  error?: string | null;
  resolveMentionCandidates?: (query: string) => MentionCandidate[];
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

type InlineCommand = "bold" | "italic" | "underline" | "strikeThrough";

/** Same link targets the renderer accepts: http(s) or site-relative. Bare hosts get https://. */
function normalizeHref(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  if (/^https?:\/\//i.test(v) || (v.startsWith("/") && !v.startsWith("//"))) return v;
  return /^[\w-]+(\.[\w-]+)+/.test(v) ? `https://${v}` : null;
}

export function MessageComposer({
  channelId,
  placeholder,
  disabled = false,
  disabledReason,
  error,
  resolveMentionCandidates,
  resolveUser,
  resolveTeam,
  onSend,
}: MessageComposerProps) {
  // `text` mirrors the editor as Markdown (send / draft / empty guard); the editor DOM
  // itself is uncontrolled — React never renders its children.
  const [text, setText] = useState<string>(() => loadDraft(channelId));
  const [before, setBefore] = useState("");
  const [selected, setSelected] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // P13: brief scale-pulse on the send button right after a message goes out
  // (paired with the pending-row slide-in below). Purely presentational — reset
  // on a timer so re-sends replay it.
  const [justSent, setJustSent] = useState(false);
  const justSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Last caret inside the editor — toolbar / popovers restore it before editing.
  const savedRange = useRef<Range | null>(null);
  // Tracks IME composition so the 変換確定 Enter never triggers submit / mention pick /
  // menu nav. Backs up isImeComposing() for browsers whose confirm keydown reports
  // isComposing=false right before compositionend.
  const composingRef = useRef(false);

  const labels = useMemo<MentionLabels>(
    () => ({
      user: (id) => resolveUser?.(id as common.UserId)?.displayName,
      team: (id) => resolveTeam?.(id)?.name,
    }),
    [resolveUser, resolveTeam],
  );
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

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

  // Channel switch (and mount): show that channel's saved draft, formatted.
  useLayoutEffect(() => {
    const md = loadDraft(channelId);
    setText(md);
    setBefore("");
    savedRange.current = null;
    if (ref.current) renderEditor(ref.current, md, labelsRef.current);
  }, [channelId]);

  // Names resolve after a draft is restored — relabel chips in place (no re-render).
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>("[data-md]").forEach((chip) => {
      const md = chip.dataset.md ?? "";
      const team = /^<!team:(.+)>$/.exec(md);
      const user = /^<@(.+)>$/.exec(md);
      const name = team ? labels.team?.(team[1]!) : user ? labels.user?.(user[1]!) : undefined;
      if (name) chip.textContent = `@${name}`;
    });
  }, [labels]);

  /** Re-read the editor into Markdown and persist it as the channel's draft. */
  const sync = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const md = serializeEditor(root);
    setText(md);
    saveDraft(channelId, md);
    setBefore(textBeforeCaret(root));
  }, [channelId]);

  // Remember the caret while it is in the editor; drive the @-trigger from it.
  useEffect(() => {
    const onSelection = () => {
      const root = ref.current;
      const r = root ? rangeIn(root) : null;
      if (!root || !r) return;
      savedRange.current = r.cloneRange();
      setBefore(textBeforeCaret(root));
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  /** Focus the editor with the caret where the user left it (toolbar clicks steal focus). */
  const restoreCaret = useCallback((): HTMLDivElement | null => {
    const root = ref.current;
    if (!root) return null;
    // focus() makes the browser pick its own caret, so a refocus always restores ours.
    const refocus = document.activeElement !== root;
    if (refocus) root.focus();
    if (refocus || !rangeIn(root)) {
      const sel = document.getSelection();
      const saved = savedRange.current;
      if (sel && saved && root.contains(saved.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(saved);
      } else caretToEnd(root);
    }
    return root;
  }, []);

  const trigger = useMemo(() => detectMentionTrigger(before, before.length), [before]);
  const candidates = useMemo(
    () => (trigger && resolveMentionCandidates ? resolveMentionCandidates(trigger.query) : []),
    [trigger, resolveMentionCandidates],
  );

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled;

  const pickMention = useCallback(
    (candidate: MentionCandidate) => {
      const root = restoreCaret();
      if (!root || !trigger) return;
      const chip = mentionChip(document, mentionToken(candidate), candidate.label, candidate.kind);
      replaceBeforeCaret(root, trigger.query.length + 1, [chip, document.createTextNode(" ")]);
      setSelected(0);
      sync();
    },
    [trigger, restoreCaret, sync],
  );

  const format = useCallback(
    (cmd: InlineCommand) => {
      if (!restoreCaret()) return;
      document.execCommand("styleWithCSS", false, "false");
      document.execCommand(cmd);
      sync();
    },
    [restoreCaret, sync],
  );

  const edit = useCallback(
    (fn: (root: HTMLDivElement) => void) => {
      const root = restoreCaret();
      if (!root) return;
      fn(root);
      sync();
    },
    [restoreCaret, sync],
  );

  const toggleBlock = useCallback((block: LineBlock) => edit((root) => toggleLineBlock(root, block)), [edit]);

  const confirmLink = useCallback(() => {
    const href = normalizeHref(linkUrl);
    if (!href) return;
    setLinkOpen(false);
    setLinkUrl("");
    edit((root) => insertLink(root, href));
  }, [linkUrl, edit]);

  const submit = useCallback(async () => {
    if (!canSend) return;
    const root = ref.current;
    const body = root ? serializeEditor(root) : text;
    const files = attachments;
    if (root) renderEditor(root, "");
    setText("");
    setBefore("");
    setAttachments([]);
    setAttachError(null);
    setEmojiOpen(false);
    setLinkOpen(false);
    clearDraft(channelId);
    // P13: pulse the send button (paired with the pending message's slide-in).
    if (justSentTimer.current) clearTimeout(justSentTimer.current);
    setJustSent(true);
    justSentTimer.current = setTimeout(() => setJustSent(false), 260);
    await onSend(body, files.length > 0 ? files : undefined);
  }, [canSend, text, attachments, channelId, onSend]);

  useEffect(() => {
    return () => {
      if (justSentTimer.current) clearTimeout(justSentTimer.current);
    };
  }, []);

  // Native beforeinput: length cap, and soft-keyboard newlines that skip keydown.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onBeforeInput = (e: InputEvent) => {
      // Caret parked on root itself (between lines) — move it into a line first so
      // typed text never lands outside the line divs.
      const r = rangeIn(root);
      if (r?.collapsed && r.startContainer === root) {
        const line = root.childNodes[r.startOffset];
        if (line) placeCaret(line, 0);
        else caretToEnd(root);
      }
      if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
        e.preventDefault();
        splitLine(root);
        sync();
        return;
      }
      if (e.inputType.startsWith("insert") && serializeEditor(root).length >= DRAFT_MAX_LEN) e.preventDefault();
    };
    root.addEventListener("beforeinput", onBeforeInput);
    return () => root.removeEventListener("beforeinput", onBeforeInput);
  }, [sync]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
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
      const cmd: InlineCommand | null =
        k === "b" ? "bold" : k === "i" ? "italic" : k === "u" ? "underline" : e.shiftKey && k === "x" ? "strikeThrough" : null;
      if (cmd) {
        e.preventDefault();
        format(cmd);
        return;
      }
    }
    if (e.key === "Backspace" && ref.current && unblockAtLineStart(ref.current)) {
      e.preventDefault();
      sync();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) edit(splitLine);
      else void submit();
    }
  };

  // Toolbar buttons must not take focus: the selection they act on lives in the editor.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className={styles.composer}>
      {candidates.length > 0 && (
        <ul className={styles.mentionMenu} role="listbox" data-testid="fe6-composer-mention-menu">
          {candidates.map((c, i) => (
            <li key={`${c.kind}:${c.id}`} role="option" aria-selected={i === selected}>
              <button type="button" aria-selected={i === selected} onMouseDown={keepFocus} onClick={() => pickMention(c)}>
                {c.kind === "team" && (
                  <span
                    className={styles.mentionTeamDot}
                    aria-hidden
                    {...(c.color && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? { style: { background: c.color } } : {})}
                  />
                )}
                <span className={styles.mentionMenuLabel}>{c.label}</span>
                {c.kind === "team" && <span className={styles.mentionMenuHint}>チーム全員に通知</span>}
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
                onMouseDown={keepFocus}
                onClick={() => {
                  edit((root) => insertText(root, e));
                  setEmojiOpen(false);
                }}
              >
                {e}
              </button>
            </li>
          ))}
        </ul>
      )}

      {linkOpen && !disabled && (
        <form
          className={styles.linkPopover}
          data-testid="fe6-composer-link-form"
          onSubmit={(e) => {
            e.preventDefault();
            confirmLink();
          }}
        >
          <input
            autoFocus
            type="text"
            inputMode="url"
            value={linkUrl}
            placeholder="https://"
            aria-label="リンク先 URL"
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setLinkOpen(false);
                restoreCaret();
              }
            }}
          />
          <button type="submit" disabled={!normalizeHref(linkUrl)}>
            追加
          </button>
        </form>
      )}

      <div className={styles.composerBox}>
        <div className={styles.toolbar} role="toolbar" aria-label="書式">
          <button type="button" className={`${styles.toolbarBtn} ${styles.bold}`} aria-label="太字" title="太字 (Cmd+B)" disabled={disabled} onMouseDown={keepFocus} onClick={() => format("bold")}>
            <Icon name="bold" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.italic}`} aria-label="斜体" title="斜体 (Cmd+I)" disabled={disabled} onMouseDown={keepFocus} onClick={() => format("italic")}>
            <Icon name="italic" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.underlineGlyph}`} aria-label="下線" title="下線 (Cmd+U)" disabled={disabled} onMouseDown={keepFocus} onClick={() => format("underline")}>
            <Icon name="underline" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.strikeGlyph}`} aria-label="取り消し線" title="取り消し線 (Cmd+Shift+X)" disabled={disabled} onMouseDown={keepFocus} onClick={() => format("strikeThrough")}>
            <Icon name="strikethrough" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.codeGlyph}`} aria-label="コード" title="インラインコード" disabled={disabled} onMouseDown={keepFocus} onClick={() => edit(toggleInlineCode)}>
            <Icon name="code" size="sm" />
          </button>
          <button type="button" className={`${styles.toolbarBtn} ${styles.codeGlyph}`} aria-label="コードブロック" title="コードブロック" disabled={disabled} onMouseDown={keepFocus} onClick={() => toggleBlock("code")}>
            <Icon name="code-block" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="引用" title="引用" disabled={disabled} onMouseDown={keepFocus} onClick={() => toggleBlock("quote")}>
            <Icon name="quote" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="箇条書き" title="箇条書き" disabled={disabled} onMouseDown={keepFocus} onClick={() => toggleBlock("bullet")}>
            <Icon name="list" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="番号付きリスト" title="番号付きリスト" disabled={disabled} onMouseDown={keepFocus} onClick={() => toggleBlock("ordered")}>
            <Icon name="list-ordered" size="sm" />
          </button>
          <span className={styles.toolbarDivider} aria-hidden />
          <button type="button" className={styles.toolbarBtn} aria-label="リンク" title="リンク" disabled={disabled} onMouseDown={keepFocus} onClick={() => {
              setEmojiOpen(false);
              setLinkOpen((o) => !o);
            }}>
            <Icon name="link" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="絵文字" title="絵文字" disabled={disabled} onMouseDown={keepFocus} onClick={() => {
              setLinkOpen(false);
              setEmojiOpen((o) => !o);
            }}>
            <Icon name="smile" size="sm" />
          </button>
          <button type="button" className={styles.toolbarBtn} aria-label="メンション" title="メンション" disabled={disabled} onMouseDown={keepFocus} onClick={() => edit((root) => insertText(root, "@"))}>
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

        <div
          ref={ref}
          role="textbox"
          aria-multiline="true"
          aria-label="メッセージ入力"
          aria-disabled={disabled || undefined}
          contentEditable={!disabled}
          suppressContentEditableWarning
          className={styles.composerInput}
          data-testid="fe6-composer-input"
          data-empty={text === "" || undefined}
          data-placeholder={disabled ? disabledReason ?? "投稿できません" : placeholder ?? "メッセージを入力"}
          onInput={(e) => {
            const root = e.currentTarget;
            const native = e.nativeEvent as InputEvent;
            if (!composingRef.current && !native.isComposing) {
              ensureLines(root);
              if (native.inputType === "insertText") applyInputRules(root);
            }
            sync();
          }}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            const r = rangeIn(e.currentTarget);
            if (!r || r.startContainer === e.currentTarget) caretToEnd(e.currentTarget);
          }}
          onPaste={(e) => {
            // Plain text only — pasted HTML would bring styles the subset can't send.
            e.preventDefault();
            if (e.clipboardData.files.length > 0) void onFilesPicked(e.clipboardData.files);
            const pasted = e.clipboardData.getData("text/plain");
            if (pasted) {
              insertText(e.currentTarget, pasted);
              ensureLines(e.currentTarget);
              sync();
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length > 0) void onFilesPicked(e.dataTransfer.files);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            sync();
          }}
        />

        <div className={styles.composerBottom}>
          <div className={styles.composerHints} aria-hidden />
          <button
            type="button"
            className={`${styles.sendButton} ${justSent ? styles.sendButtonSent : ""}`}
            disabled={!canSend}
            data-testid="fe6-composer-send"
            data-sent={justSent || undefined}
            onClick={() => void submit()}
          >
            <Icon name="send" size="sm" /> 送信
          </button>
        </div>
      </div>

      {(error || attachError) && (
        <div className={styles.composerError} role="alert" data-testid="fe6-composer-error">
          {error ?? attachError}
        </div>
      )}
      <div className={styles.composerHelp}>Enter で送信 · Shift+Enter で改行 · @ でメンション(個人 / チーム)</div>
    </div>
  );
}
