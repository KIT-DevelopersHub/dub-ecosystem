// 「Slack の絵文字を取り込む」 (編集 + chat:emoji_import): one button runs the resumable import
// (lib/custom-emoji.ts driveEmojiImport) while the modal is open, showing 取り込み済み / 全件.
// Every batch that registered something refreshes the shared emoji list, so reactions and the
// picker switch from ":name:" text to images as the import advances. Closing pauses it;
// starting again resumes cheaply (registered names are skipped server-side).
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ErrorState, Icon, Modal, useToast } from "@dub/ui";
import { useChatRuntime } from "../../context";
import type { EmojiImportResult } from "../../api/contract";
import { CUSTOM_EMOJI_MARKER, describeEmojiImportError, driveEmojiImport } from "../../lib/custom-emoji";
import { useCustomEmojis } from "../CustomEmoji";
import styles from "../slack-import/slack-import.module.css";

export interface EmojiImportModalProps {
  open: boolean;
  onClose: () => void;
}

export function EmojiImportModal({ open, onClose }: EmojiImportModalProps) {
  if (!open) return null;
  return <EmojiImportModalBody onClose={onClose} />;
}

type Phase = "idle" | "running" | "done" | "error";

function EmojiImportModalBody({ onClose }: { onClose: () => void }) {
  const { api } = useChatRuntime();
  const custom = useCustomEmojis();
  const { show } = useToast();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<EmojiImportResult | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => () => ctrl.current?.abort(), []);

  const start = useCallback(async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    // Optimistic: the run state shows at once; a refused first call rolls back to idle + error.
    setPhase("running");
    setError(null);
    setFailed([]);
    try {
      const last = await driveEmojiImport(api, {
        signal: c.signal,
        onUpdate: (r) => {
          setWaiting(r.retryAfterMs > 0);
          // A rate-limited answer (total null) carries no progress: keep the last one.
          if (r.total === null) return;
          setProgress(r);
          setTotal(r.total);
          if (r.failed.length > 0) setFailed((cur) => [...cur, ...r.failed]);
          if (r.added > 0) void custom?.reload();
        },
      });
      if (c.signal.aborted) return;
      setWaiting(false);
      setPhase("done");
      void custom?.reload();
      show({ kind: "success", title: `Slack の絵文字を取り込みました（${last?.imported ?? 0} 件）` });
    } catch (e) {
      if (c.signal.aborted) return;
      setPhase("error");
      setError(describeEmojiImportError(e));
    }
  }, [api, custom, show]);

  const imported = progress?.imported ?? 0;
  const pct = total ? Math.min(100, Math.round((imported / total) * 100)) : 0;
  const notDone = total !== null ? Math.max(0, total - imported) : 0;

  return (
    <Modal open onClose={onClose} title="Slack の絵文字を取り込む" size="md" testId="fe6-emoji-import-modal">
      <div className={styles.body} data-feature={CUSTOM_EMOJI_MARKER}>
        <div className={styles.notice} role="note">
          <Icon name="info" size="sm" />
          <ul>
            <li>Slack のカスタム絵文字を、画像そのまま（GIF アニメも）取り込みます。</li>
            <li>取り込んだ絵文字はリアクションで使えます。Slack から取り込んだリアクションも画像で表示されます。</li>
            <li>取り込み済みの絵文字はスキップされるので、何度実行しても重複しません。</li>
          </ul>
        </div>

        {phase === "error" && error ? (
          <ErrorState error={{ code: "EMOJI_IMPORT", message: error }} onRetry={() => void start()} testId="fe6-emoji-import-error" />
        ) : (
          <section className={styles.section} aria-labelledby="fe6-emoji-import-progress">
            <h3 id="fe6-emoji-import-progress" className={styles.sectionTitle}>
              取り込み状況
            </h3>
            {phase === "idle" ? (
              <p className={styles.hint}>「取り込む」を押すと始まります。この画面を開いている間に進みます。</p>
            ) : (
              <div className={styles.emojiProgress} role="status" aria-live="polite" data-testid="fe6-emoji-import-progress">
                <div className={styles.emojiProgressLabel}>
                  <span>{phase === "done" ? "完了しました" : "取り込み中…"}</span>
                  <span data-testid="fe6-emoji-import-count">
                    取り込み済み {imported} / {total ?? "…"} 件
                  </span>
                </div>
                <div className={styles.emojiProgressTrack} aria-hidden>
                  <div className={styles.emojiProgressFill} style={{ width: `${pct}%` }} />
                </div>
                {waiting && phase === "running" && (
                  <p className={styles.hint}>Slack のレート制限中です。少し待ってから自動で再開します。</p>
                )}
                {phase === "done" && notDone > 0 && (
                  <p className={styles.hint} data-testid="fe6-emoji-import-failed">
                    取り込めなかった絵文字が {notDone} 件あります{failed.length > 0 ? `（${[...new Set(failed)].slice(0, 10).map((n) => `:${n}:`).join(" ")}）` : ""}。
                  </p>
                )}
                {phase === "done" && (progress?.skipped ?? 0) > 0 && (
                  <p className={styles.hint}>標準の絵文字への別名など {progress?.skipped} 件は対象外です。</p>
                )}
              </div>
            )}
          </section>
        )}

        <div className={styles.emojiActions}>
          <Button variant="secondary" onClick={onClose} testId="fe6-emoji-import-close">
            {phase === "running" ? "一時停止して閉じる" : "閉じる"}
          </Button>
          {phase !== "error" && (
            <Button
              onClick={() => void start()}
              loading={phase === "running"}
              disabled={phase === "running"}
              iconLeft={<Icon name="refresh" size="sm" />}
              testId="fe6-emoji-import-start"
            >
              {phase === "done" ? "もう一度取り込む" : "取り込む"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
