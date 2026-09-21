// New-task composer (P0-4). A right-side drawer that captures the work unit — name,
// target worktree (cwd), and the instruction prompt — then hands it to the board, which
// creates the task (feature + task) and immediately starts a run against it. Kept
// deliberately light (design §7: "気軽さはコンポーザの軽さで担保").
import { useEffect, useRef, useState } from "react";
import { Drawer } from "./Drawer.tsx";
import { btnGhost, btnPrimary, input, t } from "./lib/theme.ts";

export interface ComposerSubmit {
  title: string;
  cwd: string;
  prompt: string;
  ledgerRef: string;
}

interface TaskComposerProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (v: ComposerSubmit) => void | Promise<void>;
  /** Preset worktree paths offered in the cwd datalist (self-brushup pin first). */
  cwdSuggestions?: string[];
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
  cwdSuggestions = [],
  submitting = false,
}: TaskComposerProps) {
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ledgerRef, setLedgerRef] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  // Reset fields each time the drawer opens (focus is handled by Drawer via initialFocusRef).
  useEffect(() => {
    if (open) {
      setTitle("");
      setCwd(cwdSuggestions[0] ?? "");
      setPrompt("");
      setLedgerRef("");
    }
  }, [open, cwdSuggestions]);

  const canSubmit = title.trim() !== "" && prompt.trim() !== "" && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    void onSubmit({
      title: title.trim(),
      cwd: cwd.trim(),
      prompt: prompt.trim(),
      ledgerRef: ledgerRef.trim(),
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

        <div>
          <label style={label} htmlFor="composer-cwd">
            対象worktree（cwd・省略時は daemon 既定）
          </label>
          <input
            id="composer-cwd"
            aria-label="task-cwd"
            list="composer-cwd-options"
            placeholder="/Users/…/dub-worktrees/feature-x"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            style={input}
          />
          <datalist id="composer-cwd-options">
            {cwdSuggestions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>

        <div>
          <label style={label} htmlFor="composer-prompt">
            指示（prompt）
          </label>
          <textarea
            id="composer-prompt"
            aria-label="task-prompt"
            placeholder="Claude Code に投げる指示を書く"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{ ...input, minHeight: 120, resize: "vertical" }}
          />
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

        <p style={{ margin: 0, fontSize: 12, color: t.textMuted }}>
          登録するだけで、まだ実行はしません。カード（または詳細）の「AIに依頼する」を押すと走ります。
        </p>
        <div style={{ display: "flex", gap: t.space3, marginTop: t.space2 }}>
          <button
            type="button"
            data-testid="composer-submit"
            onClick={submit}
            disabled={!canSubmit}
            style={{ ...btnPrimary, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? "pointer" : "default" }}
          >
            {submitting ? "登録中…" : "タスクとして登録"}
          </button>
          <button type="button" onClick={onClose} style={btnGhost}>
            キャンセル
          </button>
        </div>
      </div>
    </Drawer>
  );
}
