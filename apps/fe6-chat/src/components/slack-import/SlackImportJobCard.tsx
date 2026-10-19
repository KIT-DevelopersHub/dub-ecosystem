// One import job: phase stepper, counters, error / rate-limit wait, and the actions
// (再開 for a failed or interrupted job, チャンネルを開く once done).
import { Badge, Button, Icon } from "@dub/ui";
import type { SlackImportJob } from "../../api/contract";
import {
  COUNTER_LABELS,
  IMPORT_PHASES,
  STATUS_LABEL,
  isActiveJob,
  jobErrorText,
  stepStates,
} from "../../lib/slack-import";
import styles from "./slack-import.module.css";

const STATUS_TONE = { queued: "neutral", running: "info", done: "success", failed: "danger" } as const;

export interface SlackImportJobCardProps {
  job: SlackImportJob;
  /** The step loop stopped (network etc.) while the job is still active. */
  driveError?: string;
  pending?: boolean;
  onResume: (job: SlackImportJob) => void;
  onOpenChannel: (channelId: string) => void;
}

export function SlackImportJobCard({ job, driveError, pending = false, onResume, onOpenChannel }: SlackImportJobCardProps) {
  const states = stepStates(job);
  const error = jobErrorText(job.error) ?? driveError ?? null;
  const canResume = job.status === "failed" || (isActiveJob(job) && !!driveError);
  const waitSec = Math.ceil(job.retryAfterMs / 1000);
  return (
    <article className={styles.job} data-testid="fe6-slack-import-job" data-job-status={job.status} aria-busy={isActiveJob(job)}>
      <header className={styles.jobHeader}>
        <span className={styles.jobName}>
          {job.isPrivate ? "🔒" : "#"} {job.slackChannelName}
        </span>
        <Badge tone={job.isPrivate ? "warning" : "neutral"}>{job.isPrivate ? "非公開" : "公開"}</Badge>
        <Badge tone={STATUS_TONE[job.status]} testId="fe6-slack-import-job-status">
          {STATUS_LABEL[job.status]}
        </Badge>
      </header>

      <ol className={styles.stepper} aria-label="取り込みの進行">
        {IMPORT_PHASES.map((p, i) => (
          <li
            key={p.phase}
            className={styles.step}
            data-state={states[i]}
            aria-current={states[i] === "current" ? "step" : undefined}
          >
            {states[i] === "complete" ? <Icon name="check" size="sm" /> : null}
            {p.label}
          </li>
        ))}
      </ol>

      <dl className={styles.counters}>
        {COUNTER_LABELS.map((c) => (
          <div key={c.key} className={styles.counter}>
            <dt>{c.label}</dt>
            <dd data-testid={`fe6-slack-import-count-${c.key}`}>{job.counters[c.key].toLocaleString("ja-JP")}</dd>
          </div>
        ))}
      </dl>

      {job.status === "running" && waitSec > 0 && (
        <p className={styles.jobWait} role="status">
          Slack のレート制限のため {waitSec} 秒待ってから続けます…
        </p>
      )}
      {error && (
        <p className={styles.jobError} role="alert" data-testid="fe6-slack-import-job-error">
          {error}
        </p>
      )}

      <div className={styles.jobActions}>
        {canResume && (
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => onResume(job)} testId="fe6-slack-import-resume">
            再開
          </Button>
        )}
        {job.status === "done" && job.dubChannelId && (
          <Button size="sm" onClick={() => onOpenChannel(job.dubChannelId)} testId="fe6-slack-import-open-channel">
            チャンネルを開く
          </Button>
        )}
      </div>
    </article>
  );
}
