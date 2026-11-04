// New-task composer (P0-4). A right-side drawer that captures the work unit — name and
// the instruction prompt — then hands it to the board, which
// creates the task (feature + task) and immediately starts a run against it. Kept
// deliberately light (design §7: "気軽さはコンポーザの軽さで担保"). There is no cwd field:
// the daemon gives every task its own worktree + Claude session (never another task's).
import { useEffect, useRef, useState } from "react";
import { Drawer } from "./Drawer.tsx";
import { btnGhost, btnPrimary, input, t } from "./lib/theme.ts";
import type { ChatImage } from "./lib/images.ts";
import { AttachButton, AttachmentTray, dropOutline, useImageAttachments } from "./ImageAttach.tsx";

export interface ComposerSubmit {
  title: string;
  prompt: string;
  ledgerRef: string;
  /** Pasted / dropped screenshots sent with the first run. */
  images: ChatImage[];
}

interface TaskComposerProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (v: ComposerSubmit) => void | Promise<void>;
  submitting?: boolean;
}

const label: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: t.textMuted,
  marginBottom: t.space1,
};

export function TaskComposer({
  open,
  onClose,
  onSubmit,
  submitting = false,
}: TaskComposerProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ledgerRef, setLedgerRef] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const att = useImageAttachments();


  // Reset fields only when the drawer transitions open (not on every poll-driven
  // re-render). Focus is handled by Drawer via initialFocusRef.
  useEffect(() => {
    if (open) {
      setTitle("");
      setPrompt("");
      setLedgerRef("");
      att.clear();
    }
  }, [open]);

  const canSubmit = title.trim() !== "" && prompt.trim() !== "" && !submitting && att.preparing === 0;

  const submit = () => {
    if (!canSubmit) return;
    void onSubmit({
      title: title.trim(),
      prompt: prompt.trim(),
      ledgerRef: ledgerRef.trim(),
      images: att.images,
    });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="新規タスクを投入"
      testId="task-composer"
      initialFocusRef={titleRef}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: t.space5 }}>
        <div>
          <label style={label} htmlFor="composer-title">
            タスク名
          </label>
          <input
            id="composer-title"
            ref={titleRef}
            aria-label="task-title"
            placeholder="例: メンバー名簿にロール絞り込みを追加"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={input}
          />
        </div>

        <p data-testid="composer-workspace-note" style={{ margin: 0, fontSize: 12, color: t.textMuted }}>
          作業ディレクトリはタスクごとに自動で用意されます（他のタスクと共有しません）。
        </p>

        <div {...att.dropProps} data-testid="composer-prompt-drop" style={dropOutline(att.dragging)}>
          <label style={label} htmlFor="composer-prompt">
            指示（prompt）
          </label>
          <textarea
            id="composer-prompt"
            aria-label="task-prompt"
            placeholder="Claude Code に投げる指示を書く（画像は貼り付け・ドロップでも添付できます）"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={att.onPaste}
            style={{ ...input, minHeight: 120, resize: "vertical" }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: t.space2, marginTop: t.space2 }}>
            <AttachmentTray att={att} testIdPrefix="composer" />
            <div>
              <AttachButton att={att} testIdPrefix="composer" label="📎 画像を添付" />
            </div>
          </div>
        </div>

        <div>
          <label style={label} htmlFor="composer-ledger">
            台帳参照（任意）
          </label>
          <input
            id="composer-ledger"
            aria-label="task-ledger"
            placeholder="Dub_フィーチャー台帳 の該当エントリ 等"
            value={ledgerRef}
            onChange={(e) => setLedgerRef(e.target.value)}
            style={input}
          />
        </div>

        <div style={{ display: "flex", gap: t.space3, marginTop: t.space2 }}>
          <button
            type="button"
            data-testid="composer-submit"
            onClick={submit}
            disabled={!canSubmit}
            style={{ ...btnPrimary, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? "pointer" : "default" }}
          >
            {submitting ? "投入中…" : "投入して走らせる"}
          </button>
          <button type="button" onClick={onClose} style={btnGhost}>
            キャンセル
          </button>
        </div>
      </div>
    </Drawer>
  );
}
