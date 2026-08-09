// Private deploy-jobs queue message. NOT a contract event (no envelope), so it is
// kept deliberately small and versioned by a literal tag for forward-compat.
export interface DeployJobMessage {
  tag: "deploy-job/v1";
  kind: "execute" | "poll";
  deploymentId: string;
  siteId: string;
  cfProjectName: string;
  branch: string;
  commitSha: string | null;
  // correlation + audit-result linkage
  requestId: string;
  actorId: string | null;
  intentId: string; // audit intent record id (details.intent_id on result)
  attempt: number;
}
