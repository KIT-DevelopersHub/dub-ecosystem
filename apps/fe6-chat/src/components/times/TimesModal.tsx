// 「times を作成」 (編集 + chat:times, #850). Each member gets their own times channel in this
// chat (owner = the member). Opens on a DRY-RUN preview (who has no times channel and which name
// they would get) — nothing is created until the admin presses 「times が無いメンバーに作成」.
// Creation runs in bounded batches while the modal is open (the server answers `remaining`); a
// batch that makes no progress stops the loop.
import { useCallback, useEffect, useRef, useState } from "react";
import type { chat } from "@dub/types";
import { Button, EmptyState, ErrorState, Icon, Modal, SkeletonList, useToast } from "@dub/ui";
import { useChatRuntime } from "../../context";
import base from "../slack-import/slack-import.module.css";
import styles from "./times.module.css";

export interface TimesModalProps {
  open: boolean;
  onClose: () => void;
}

export function TimesModal({ open, onClose }: TimesModalProps) {
  if (!open) return null;
  return <TimesModalBody onClose={onClose} />;
}

const STATUS_LABEL: Record<chat.TimesItem["status"], string> = {
  planned: "作成予定",
  existing: "本人のチャンネルが既にあるので記録のみ",
  created: "作成しました",
  recorded: "作成済み",
  failed: "失敗",
};

/** Admin-facing text for a failed call. */
export function describeTimesError(e: unknown): string {
  const err = (e ?? {}) as { status?: number; message?: string; body?: { error?: { message?: string } } };
  const msg = err.body?.error?.message ?? err.message;
  switch (err.status) {
    case 412:
      return "times の作成はまだ使えるようになっていません。管理者にお問い合わせください。";
    case 403:
      return "times を作成する権限がありません。";
    default:
      return msg || "通信に失敗しました。もう一度お試しください。";
  }
}

type Phase = "loading" | "preview" | "running" | "done" | "error";

function TimesModalBody({ onClose }: { onClose: () => void }) {
  const { api } = useChatRuntime();
  const { show } = useToast();
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<chat.TimesPreviewResponse | null>(null);
  const [results, setResults] = useState<chat.TimesItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const load = useCallback(async () => {
    if (!api.previewTimes) return;
    setPhase("loading");
    setError(null);
    try {
      const p = await api.previewTimes();
      if (!alive.current) return;
      setPreview(p);
      setPhase("preview");
    } catch (e) {
      if (!alive.current) return;
      setError(describeTimesError(e));
      setPhase("error");
    }
  }, [api]);

  useEffect(() => void load(), [load]);

  const run = useCallback(async () => {
    if (!api.bulkCreateTimes) return;
    setPhase("running");
    setResults([]);
    const all: chat.TimesItem[] = [];
    try {
      for (;;) {
        const r = await api.bulkCreateTimes();
        if (!alive.current) return;
        all.push(...r.results);
        setResults([...all]);
        const progressed = r.results.some((i) => i.status === "created" || i.status === "existing");
        if (r.remaining === 0 || !progressed) break;
      }
      setPhase("done");
      const ok = all.filter((i) => i.status === "created" || i.status === "existing").length;
      show({ kind: "success", title: `times チャンネルを ${ok} 件用意しました` });
    } catch (e) {
      if (!alive.current) return;
      setError(describeTimesError(e));
      setPhase("error");
    }
  }, [api, show]);

  const targets = preview?.items ?? [];
  const rows = phase === "running" || phase === "done" ? results : targets;

  return (
    <Modal open onClose={onClose} title="times を作成" size="md" testId="fe6-times-modal">
      <div className={base.body}>
        <div className={base.notice} role="note">
          <Icon name="info" size="sm" />
          <ul>
            <li>
              名前は <code>{preview?.config.prefix ?? "times-"}&lt;表示名&gt;</code>（日本語もそのまま・英字は小文字）。
              {preview?.config.isPrivate ? "プライベート" : "公開"}チャンネルで作り、本人をオーナーにします。
            </li>
            <li>同じ名前が既に使われていれば <code>-2</code>・<code>-3</code> を付けます。</li>
            <li>新しいメンバーが参加した時は{preview?.config.autoCreate === false ? "自動では作りません。" : "自動で作られます。"}</li>
          </ul>
        </div>

        {phase === "error" && error ? (
          <ErrorState error={{ code: "TIMES", message: error }} onRetry={() => void load()} testId="fe6-times-error" />
        ) : phase === "loading" ? (
          <SkeletonList rows={4} />
        ) : (
          <section className={base.section} aria-labelledby="fe6-times-list">
            <h3 id="fe6-times-list" className={base.sectionTitle}>
              {phase === "preview" ? `作成予定（${targets.length} 人・まだ何も作っていません）` : "結果"}
            </h3>
            {rows.length === 0 ? (
              <EmptyState title="times が無いメンバーはいません" testId="fe6-times-empty" />
            ) : (
              <ul className={styles.list} data-testid="fe6-times-rows">
                {rows.map((i) => (
                  <li key={i.userId} className={styles.row}>
                    <span className={styles.name}>{i.displayName}</span>
                    <span className={styles.channel}>
                      {i.channelName ? `#${i.channelName}` : ""}　{STATUS_LABEL[i.status]}
                      {i.error ? `（${i.error}）` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {phase === "preview" && (preview?.recordedCount ?? 0) > 0 && (
              <p className={base.hint}>既に times がある {preview?.recordedCount} 人は対象外です。</p>
            )}
          </section>
        )}

        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose} testId="fe6-times-close">
            閉じる
          </Button>
          {(phase === "preview" || phase === "running") && (
            <Button
              onClick={() => void run()}
              loading={phase === "running"}
              disabled={phase === "running" || targets.length === 0}
              testId="fe6-times-run"
            >
              times が無いメンバーに作成
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
