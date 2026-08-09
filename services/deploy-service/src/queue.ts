// Private deploy-jobs consumer: performs the async CF Pages deployment, tracks the
// state machine (queued -> building -> live|failed), emits status events and the
// result-stage audit (linked to the intent id). CF *business* failures are terminal
// (recorded as failed + acked); only unexpected infra errors bubble to retry().
import type { MessageBatch } from "@cloudflare/workers-types";
import { nowIso } from "@dub/db";
import { isDubError } from "@dub/errors";
import type { deploy } from "@dub/types";
import type { Env } from "./env";
import type { Deps, DepsFactory } from "./deps";
import { buildDeps } from "./deps";
import type { DeployJobMessage } from "./jobs";

const MAX_POLL_ATTEMPTS = 20;
const POLL_DELAY_SECONDS = 10;

export async function handleDeployJobs(
  batch: MessageBatch<DeployJobMessage>,
  env: Env,
  makeDeps: DepsFactory = buildDeps,
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      const deps = makeDeps(env, job.requestId);
      await processJob(deps, job);
      message.ack();
    } catch {
      message.retry(); // unexpected/transient infra error -> redelivery (DLQ on exhaustion)
    }
  }
}

async function processJob(deps: Deps, job: DeployJobMessage): Promise<void> {
  const current = await deps.repo.getDeployment(job.deploymentId);
  if (!current) return; // nothing to do (row gone)
  if (isTerminal(current.status)) return; // idempotent: already finalized

  if (job.kind === "execute") {
    await runExecute(deps, job, current.status);
    return;
  }
  await runPoll(deps, job);
}

async function runExecute(deps: Deps, job: DeployJobMessage, currentStatus: deploy.DeploymentStatus): Promise<void> {
  if (currentStatus === "queued") {
    await deps.repo.updateDeployment(job.deploymentId, { status: "building" });
    await emitStatus(deps, job, "building");
  }
  let result;
  try {
    result = await deps.cf.createPagesDeployment({
      cfProjectName: job.cfProjectName,
      branch: job.branch,
      commitSha: job.commitSha,
    });
  } catch (err) {
    await finalize(deps, job, "failed", null, errMsg(err));
    return;
  }
  await deps.repo.updateDeployment(job.deploymentId, { cfDeploymentId: result.cfDeploymentId });
  if (isTerminal(result.status)) {
    await finalize(deps, job, result.status, result.url, null);
    return;
  }
  // still building on CF side -> schedule a poll
  await deps.enqueueJob({ ...job, kind: "poll", attempt: job.attempt + 1 }, { delaySeconds: POLL_DELAY_SECONDS });
}

async function runPoll(deps: Deps, job: DeployJobMessage): Promise<void> {
  const current = await deps.repo.getDeployment(job.deploymentId);
  if (!current || !current.cfDeploymentId) {
    await finalize(deps, job, "failed", null, "missing cf deployment id during poll");
    return;
  }
  let result;
  try {
    result = await deps.cf.getPagesDeployment({
      cfProjectName: job.cfProjectName,
      cfDeploymentId: current.cfDeploymentId,
    });
  } catch (err) {
    await finalize(deps, job, "failed", null, errMsg(err));
    return;
  }
  if (isTerminal(result.status)) {
    await finalize(deps, job, result.status, result.url, null);
    return;
  }
  if (job.attempt >= MAX_POLL_ATTEMPTS) {
    await finalize(deps, job, "failed", null, "deployment did not settle within poll budget");
    return;
  }
  await deps.enqueueJob({ ...job, attempt: job.attempt + 1 }, { delaySeconds: POLL_DELAY_SECONDS });
}

async function finalize(
  deps: Deps,
  job: DeployJobMessage,
  status: deploy.DeploymentStatus,
  url: string | null,
  errorMessage: string | null,
): Promise<void> {
  await deps.repo.updateDeployment(job.deploymentId, {
    status,
    url,
    errorMessage,
    finishedAt: nowIso(),
  });
  await emitStatus(deps, job, status);
  await deps.audit.recordResult(
    { requestId: job.requestId, ...(job.actorId ? { userId: job.actorId } : {}) },
    {
      action: "infra.deploy.executed",
      actorId: job.actorId,
      result: status === "live" ? "success" : "failure",
      resourceType: "deployment",
      resourceId: job.deploymentId,
      intentId: job.intentId,
      details: { siteId: job.siteId, status, ...(url ? { url } : {}) },
    },
  );
}

async function emitStatus(deps: Deps, job: DeployJobMessage, status: deploy.DeploymentStatus): Promise<void> {
  await deps.events.deploymentStatusChanged(
    { requestId: job.requestId, actorId: job.actorId },
    { deploymentId: job.deploymentId, status },
  );
}

function isTerminal(status: deploy.DeploymentStatus): boolean {
  return status === "live" || status === "failed";
}

function errMsg(err: unknown): string {
  if (isDubError(err)) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : "unknown error";
}
