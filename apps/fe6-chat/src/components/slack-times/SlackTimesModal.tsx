// 「Slack の times を作成」 (編集 + chat:slack_times, #850). Opens on a DRY-RUN preview (who
// has no times channel and which name they would get) — nothing is created until the admin
// presses 「times が無いメンバーに作成」. Creation runs in bounded batches while the modal is
// open (the server answers `remaining`); a batch that makes no progress stops the loop.
import { useCallback, useEffect, useRef, useState } from "react";
import type { chat } from "@dub/types";
import { Button, EmptyState, ErrorState, Icon, Modal, SkeletonList, useToast } from "@dub/ui";
import { useChatRuntime } from "../../context";
import base from "../slack-import/slack-import.module.css";
import styles from "./slack-times.module.css";

export interface SlackTimesModalProps {
  open: boolean;
  onClose: () => void;
}

export function SlackTimesModal({ open, onClose }: SlackTimesModalProps) {
  if (!open) return null;
  return <SlackTimesModalBody onClose={onClose} />;
}

const STATUS_LABEL: Record<chat.SlackTimesItem["status"], string> = {
  planned: "作成予定",
  existing: "既にあるので記録のみ",
  created: "作成しました",
  recorded: "作成済み",
  no_slack_account: "Slack アカウントが見つかりません",
  failed: "失敗",
};

/** Admin-facing text for a failed call (412 carries the scope list in the message). */
export function describeSlackTimesError(e: unknown): string {
  const err = (e ?? {}) as { status?: number; message?: string; body?: { error?: { message?: string } } };
  const msg = err.body?.error?.message ?? err.message;
  switch (err.status) {
    case 412:
      return msg && msg !== "slack_times_not_configured" ? msg : "Slack 連携がまだ設定されていません。管理者に SLACK_BOT_TOKEN の設定を依頼してください。";
    case 403:
      return "times を作成する権限がありません。";
    case 429:
      return "Slack のレート制限中です。少し待ってからもう一度お試しください。";
    default:
      return msg || "通信に失敗しました。もう一度お試しください。";
  }
}

type Phase = "loading" | "preview" | "running" | "done" | "error";

function SlackTimesModalBody({ onClose }: { onClose: () => void }) {
  const { api } = useChatRuntime();
  const { show } = useToast();
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<chat.SlackTimesPreviewResponse | null>(null);
  const [results, setResults] = useState<chat.SlackTimesItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const load = useCallback(async () => {
    if (!api.previewSlackTimes) return;
    setPhase("loading");
    setError(null);
    try {
      const p = await api.previewSlackTimes();
      if (!alive.current) return;
      setPreview(p);
      setPhase("preview");
    } catch (e) {
      if (!alive.current) return;
      setError(describeSlackTimesError(e));
      setPhase("error");
    }
  }, [api]);

  useEffect(() => void load(), [load]);

  const run = useCallback(async () => {
    if (!api.bulkCreateSlackTimes) return;
    setPhase("running");
    setResults([]);
    const all: chat.SlackTimesItem[] = [];
    try {
      for (;;) {
        const r = await api.bulkCreateSlackTimes();
        if (!alive.current) return;
        all.push(...r.results.filter((i) => i.status !== "no_slack_account"));
        setResults([...all]);
        const progressed = r.results.some((i) => i.status === "created" || i.status === "existing");
        if (r.remaining === 0 || !progressed) break;
      }
      setPhase("done");
      const ok = all.filter((i) => i.status === "created" || i.status === "existing").length;
      show({ kind: "success", title: `times チャンネルを ${ok} 件用意しました` });
    } catch (e) {
      if (!alive.current) return;
      setError(describeSlackTimesError(e));
      setPhase("error");
    }
  }, [api, show]);

  const targets = preview?.items.filter((i) => i.status !== "no_slack_account") ?? [];
  const noAccount = preview?.items.filter((i) => i.status === "no_slack_account") ?? [];
  const rows = phase === "running" || phase === "done" ? results : targets;

  return (
    <Modal open onClose={onClose} title="Slack の times を作成" size="md" testId="fe6-slack-times-modal">
      <div className={base.body}>
        <div className={base.notice} role="note">
          <Icon name="info" size="sm" />
          <ul>
            <li>
              名前は <code>{preview?.config.prefix ?? "times-"}&lt;Slack の表示名&gt;</code>（小文字）。
              {preview?.config.isPrivate ? "プライベート" : "公開"}チャンネルで作り、本人を招待します。
            </li>
            <li>同じ名前のチャンネルが既にあれば作らず、その人の times として記録します。</li>
            <li>新しいメンバーが参加した時は{preview?.config.autoCreate === false ? "自動では作りません。" : "自動で作られます。"}</li>
          </ul>
        </div>

        {phase === "error" && error ? (
          <ErrorState error={{ code: "SLACK_TIMES", message: error }} onRetry={() => void load()} testId="fe6-slack-times-error" />
        ) : phase === "loading" ? (
          <SkeletonList rows={4} />
        ) : (
          <section className={base.section} aria-labelledby="fe6-slack-times-list">
            <h3 id="fe6-slack-times-list" className={base.sectionTitle}>
              {phase === "preview" ? `作成予定（${targets.length} 人・まだ何も作っていません）` : "結果"}
            </h3>
            {rows.length === 0 ? (
              <EmptyState title="times が無いメンバーはいません" testId="fe6-slack-times-empty" />
            ) : (
              <ul className={styles.list} data-testid="fe6-slack-times-rows">
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
            {phase === "preview" && noAccount.length > 0 && (
              <p className={base.hint} data-testid="fe6-slack-times-no-account">
                Slack アカウント（同じメールアドレス）が見つからない {noAccount.length} 人は対象外です:{" "}
                {noAccount.slice(0, 10).map((i) => i.displayName).join("、")}
              </p>
            )}
            {phase === "preview" && (preview?.recordedCount ?? 0) > 0 && (
              <p className={base.hint}>既に times がある {preview?.recordedCount} 人は対象外です。</p>
            )}
          </section>
        )}

        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose} testId="fe6-slack-times-close">
            閉じる
          </Button>
          {(phase === "preview" || phase === "running") && (
            <Button
              onClick={() => void run()}
              loading={phase === "running"}
              disabled={phase === "running" || targets.length === 0}
              testId="fe6-slack-times-run"
            >
              times が無いメンバーに作成
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
