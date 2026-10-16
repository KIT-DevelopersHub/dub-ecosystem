// 「チャンネル取り込み」 (admin): pick a Slack channel (or type its name) -> 取り込む creates
// a job that this screen drives step by step; each job shows its progress and, when done,
// opens the new Dub channel. Closing pauses the job; reopening resumes it.
import { useCallback, useState } from "react";
import { Button, EmptyState, ErrorState, FormField, Icon, Modal, SkeletonList, TextField, useToast } from "@dub/ui";
import { useChatRuntime } from "../../context";
import type { SlackChannelOption, SlackImportJob } from "../../api/contract";
import { isPendingJob, useSlackImport } from "../../hooks/useSlackImport";
import { SLACK_IMPORT_MARKER, describeImportError, isActiveJob, isNotConfigured, normalizeSlackChannelRef } from "../../lib/slack-import";
import { SlackChannelPicker } from "./SlackChannelPicker";
import { SlackImportJobCard } from "./SlackImportJobCard";
import styles from "./slack-import.module.css";

export interface SlackImportModalProps {
  open: boolean;
  onClose: () => void;
  /** A job finished: the new channel exists — refresh the sidebar. */
  onImported: (job: SlackImportJob) => void;
  onOpenChannel: (channelId: string) => void;
}

export function SlackImportModal({ open, ...rest }: SlackImportModalProps) {
  if (!open) return null;
  return <SlackImportModalBody {...rest} />;
}

function SlackImportModalBody({ onClose, onImported, onOpenChannel }: Omit<SlackImportModalProps, "open">) {
  const { api } = useChatRuntime();
  const { show } = useToast();
  const state = useSlackImport(api, {
    onJobDone: (job) => {
      onImported(job);
      show({ kind: "success", title: `#${job.slackChannelName} の取り込みが完了しました` });
    },
    onError: (message) => show({ kind: "error", title: "取り込みを開始できませんでした", description: message }),
  });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [starting, setStarting] = useState(false);

  const target = normalizeSlackChannelRef(manual) || selected;
  const statusOf = useCallback(
    (c: SlackChannelOption) => state.jobs?.find((j) => j.slackChannelId === c.id)?.status ?? c.job?.status ?? null,
    [state.jobs],
  );

  const submit = async () => {
    if (!target || starting) return;
    setStarting(true);
    try {
      const job = await state.start(target);
      if (job) {
        setSelected(null);
        setManual("");
      }
    } finally {
      setStarting(false);
    }
  };

  const notConfigured = isNotConfigured(state.channelsError) || isNotConfigured(state.jobsError);

  return (
    <Modal open onClose={onClose} title="Slack チャンネル取り込み" size="lg" testId="fe6-slack-import-modal">
      <div className={styles.body} data-feature={SLACK_IMPORT_MARKER}>
        <div className={styles.notice} role="note">
          <Icon name="info" size="sm" />
          <ul>
            <li>Slack 無料プランのため、取り込めるのは直近 90 日分のメッセージとファイルです。</li>
            <li>非公開チャンネルは、Slack で LMB を招待すると一覧に表示されます。</li>
            <li>同じ名前の新しいチャンネルとして作成されます。何度取り込んでも重複しません。</li>
          </ul>
        </div>

        {notConfigured ? (
          <ErrorState
            error={{ code: "PRECONDITION_FAILED", message: describeImportError(state.channelsError ?? state.jobsError) }}
            onRetry={state.reload}
            testId="fe6-slack-import-not-configured"
          />
        ) : (
          <>
            <section className={styles.section} aria-labelledby="fe6-slack-import-pick">
              <h3 id="fe6-slack-import-pick" className={styles.sectionTitle}>
                取り込むチャンネル
              </h3>
              {state.channelsError ? (
                <ErrorState error={{ code: "SLACK_IMPORT", message: describeImportError(state.channelsError) }} onRetry={state.reload} />
              ) : (
                <SlackChannelPicker
                  channels={state.channels}
                  query={query}
                  onQueryChange={setQuery}
                  selected={manual ? null : selected}
                  onSelect={(name) => {
                    setSelected(name);
                    setManual("");
                  }}
                  statusOf={statusOf}
                />
              )}
              <div className={styles.startRow}>
                <FormField
                  label="一覧にない場合はチャンネル名を入力"
                  htmlFor="fe6-slack-import-manual"
                  help="チャンネル名（#general）か Slack のチャンネル ID"
                >
                  <TextField id="fe6-slack-import-manual" value={manual} onChange={setManual} placeholder="#channel-name" testId="fe6-slack-import-manual" />
                </FormField>
                <Button
                  onClick={() => void submit()}
                  disabled={!target}
                  loading={starting}
                  iconLeft={<Icon name="refresh" size="sm" />}
                  testId="fe6-slack-import-start"
                >
                  取り込む
                </Button>
              </div>
              {target && <p className={styles.hint}>取り込み対象: #{target}</p>}
            </section>

            <section className={styles.section} aria-labelledby="fe6-slack-import-jobs">
              <h3 id="fe6-slack-import-jobs" className={styles.sectionTitle}>
                取り込み状況
              </h3>
              <p className={styles.hint}>この画面を開いている間に進みます。閉じると一時停止し、次に開いたときに続きから再開します。</p>
              {state.jobs === null && !state.jobsError ? (
                <SkeletonList rows={2} testId="fe6-slack-import-jobs-loading" />
              ) : state.jobsError ? (
                <ErrorState error={{ code: "SLACK_IMPORT", message: describeImportError(state.jobsError) }} onRetry={state.reload} />
              ) : state.jobs && state.jobs.length === 0 ? (
                <EmptyState icon="history" title="まだ取り込みはありません" description="上でチャンネルを選んで「取り込む」を押してください。" />
              ) : (
                <div className={styles.jobs} data-testid="fe6-slack-import-jobs">
                  {(state.jobs ?? []).map((job) => (
                    <SlackImportJobCard
                      key={job.id}
                      job={job}
                      pending={isPendingJob(job)}
                      {...(state.driveErrors[job.id] && isActiveJob(job) ? { driveError: state.driveErrors[job.id] } : {})}
                      onResume={(j) => void state.resume(j)}
                      onOpenChannel={onOpenChannel}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
