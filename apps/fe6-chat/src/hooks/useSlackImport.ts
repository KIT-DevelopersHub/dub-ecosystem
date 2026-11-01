// State + engine for the Slack channel import screen. Loads the Slack channel picker and
// recent jobs, then drives every queued/running job (step loop) while mounted — so
// reopening the screen resumes an interrupted import. Start is optimistic: a queued row
// appears at once and is rolled back (with the error) if the server refuses.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatApiClient } from "../api/client";
import type { SlackChannelOption, SlackImportJob } from "../api/contract";
import { describeImportError, driveSlackImport, isActiveJob } from "../lib/slack-import";

export interface SlackImportState {
  channels: SlackChannelOption[] | null; // null = loading
  channelsError: unknown;
  jobs: SlackImportJob[] | null; // null = loading
  jobsError: unknown;
  /** jobId -> why its step loop stopped (network etc.); cleared on 再開. */
  driveErrors: Record<string, string>;
  start: (channelRef: string) => Promise<SlackImportJob | null>;
  resume: (job: SlackImportJob) => Promise<void>;
  reload: () => void;
}

const TEMP_PREFIX = "pending:";
export const isPendingJob = (job: SlackImportJob): boolean => job.id.startsWith(TEMP_PREFIX);

function pendingJob(channel: SlackChannelOption | undefined, ref: string): SlackImportJob {
  const now = new Date().toISOString();
  return {
    id: `${TEMP_PREFIX}${ref}`,
    slackChannelId: channel?.id ?? ref,
    slackChannelName: channel?.name ?? ref,
    isPrivate: channel?.isPrivate ?? false,
    dubChannelId: "",
    status: "queued",
    phase: "users",
    counters: { members: 0, messages: 0, threadReplies: 0, reactions: 0, pins: 0, files: 0, filesSkipped: 0 },
    pending: { threads: 0, files: 0 },
    error: null,
    retryAfterMs: 0,
    createdBy: "",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
}

/** Insert or replace by id (or by Slack channel — one job per channel), newest first. */
function upsert(list: SlackImportJob[], job: SlackImportJob, replaceId?: string): SlackImportJob[] {
  const rest = list.filter((j) => j.id !== job.id && j.id !== replaceId && j.slackChannelId !== job.slackChannelId);
  return [job, ...rest];
}

export function useSlackImport(
  api: ChatApiClient,
  { onJobDone, onError }: { onJobDone?: (job: SlackImportJob) => void; onError?: (message: string) => void } = {},
): SlackImportState {
  const [channels, setChannels] = useState<SlackChannelOption[] | null>(null);
  const [channelsError, setChannelsError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<SlackImportJob[] | null>(null);
  const [jobsError, setJobsError] = useState<unknown>(null);
  const [driveErrors, setDriveErrors] = useState<Record<string, string>>({});
  const [loadSeq, setLoadSeq] = useState(0);
  const running = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const callbacks = useRef({ onJobDone, onError });
  callbacks.current = { onJobDone, onError };

  useEffect(() => {
    mounted.current = true;
    const loops = running.current;
    return () => {
      mounted.current = false;
      for (const c of loops.values()) c.abort();
      loops.clear();
    };
  }, []);

  const drive = useCallback(
    (job: SlackImportJob) => {
      if (!isActiveJob(job) || running.current.has(job.id)) return;
      const ctrl = new AbortController();
      running.current.set(job.id, ctrl);
      void driveSlackImport(api, job, {
        signal: ctrl.signal,
        onUpdate: (next) => {
          if (!mounted.current) return;
          setJobs((cur) => upsert(cur ?? [], next));
          if (next.status === "done") callbacks.current.onJobDone?.(next);
        },
      })
        .catch((e: unknown) => {
          if (mounted.current && !ctrl.signal.aborted) setDriveErrors((cur) => ({ ...cur, [job.id]: describeImportError(e) }));
        })
        .finally(() => {
          if (running.current.get(job.id) === ctrl) running.current.delete(job.id);
        });
    },
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    setChannels(null);
    setJobs(null);
    setChannelsError(null);
    setJobsError(null);
    api.listSlackChannels().then(
      (list) => !cancelled && setChannels(list),
      (e: unknown) => !cancelled && setChannelsError(e ?? new Error("failed")),
    );
    api.listSlackImportJobs(20).then(
      (list) => {
        if (cancelled) return;
        setJobs(list);
        for (const j of list) drive(j); // resume what an earlier visit left running
      },
      (e: unknown) => !cancelled && setJobsError(e ?? new Error("failed")),
    );
    return () => {
      cancelled = true;
    };
  }, [api, drive, loadSeq]);

  const start = useCallback(
    async (channelRef: string) => {
      const option = channels?.find((c) => c.name === channelRef || c.id === channelRef);
      const temp = pendingJob(option, channelRef);
      let snapshot: SlackImportJob[] | null = null;
      setJobs((cur) => {
        snapshot = cur;
        return upsert(cur ?? [], temp);
      });
      try {
        const job = await api.startSlackImport(channelRef);
        if (!mounted.current) return job;
        setJobs((cur) => upsert(cur ?? [], job, temp.id));
        setDriveErrors(({ [job.id]: _drop, ...rest }) => rest);
        drive(job);
        return job;
      } catch (e) {
        if (mounted.current) setJobs(snapshot);
        callbacks.current.onError?.(describeImportError(e));
        return null;
      }
    },
    [api, channels, drive],
  );

  const resume = useCallback(
    async (job: SlackImportJob) => {
      setDriveErrors(({ [job.id]: _drop, ...rest }) => rest);
      if (job.status === "failed") {
        await start(job.slackChannelId); // server resumes a failed job from its cursor
        return;
      }
      drive(job);
    },
    [drive, start],
  );

  const reload = useCallback(() => setLoadSeq((n) => n + 1), []);

  return { channels, channelsError, jobs, jobsError, driveErrors, start, resume, reload };
}
