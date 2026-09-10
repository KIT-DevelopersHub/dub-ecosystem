// Lane-A declarative mapping (design §4): domain event → notification. Rules do
// format conversion + recipient EXPANSION only; they never re-decide "whether to
// notify" (that lives in the producer's publish). The subscription set must mirror
// the frozen @dub/events SUBSCRIPTIONS catalog for consumer "notification".
import type { DubEventName } from "@dub/events";
import type {
  ActionArchivedPayload,
  ActionCreatedPayload,
  ActionStatusChangedPayload,
  ActionUpdatedPayload,
  ChatMessageCreatedPayload,
  DeployDeploymentStatusChangedPayload,
  DeployDnsRecordChangedPayload,
  EventArchivedPayload,
  EventCreatedPayload,
  EventPhaseChangedPayload,
  EventUpdatedPayload,
  GithubConflictDetectedPayload,
  GithubSyncFailedPayload,
  PublicInquiryReceivedPayload,
  TaskArchivedPayload,
  TaskAssignedPayload,
  TaskCreatedPayload,
  TaskDueSoonPayload,
  TaskStatusChangedPayload,
} from "@dub/events";
import type { EventMappingRule, NotifyRecipients } from "./types";

// Role keys used for operational / admin fan-out (identity GET /users?roleKey=).
const ROLE_ADMIN = "admin";
const ROLE_ORGANIZER = "organizer";

// eventId is optional on task.* payloads now (判断44). An unlinked task has no event
// audience, so recipients resolve to none by event scope (assignee-scoped rules, where
// present, still apply). recipients.ts already guards `if (recipients.eventId)`.
const byEvent = (eventId: string | undefined): NotifyRecipients => (eventId ? { eventId } : {});

export const EVENT_MAPPINGS: Partial<Record<DubEventName, EventMappingRule>> = {
  // ---- task ----
  "task.created": {
    type: "task.created",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as TaskCreatedPayload).eventId),
    buildContent: (p) => ({ title: "New task created", resourceType: "task", resourceId: (p as TaskCreatedPayload).taskId }),
  },
  "task.assigned": {
    type: "task.assigned",
    channels: ["in_app", "email"],
    priority: "normal", // urgent扱いはしない (design §4)
    buildRecipients: (p) => {
      const a = (p as TaskAssignedPayload).assigneeId;
      return a ? { userIds: [a] } : {};
    },
    buildContent: (p) => ({ title: "A task was assigned to you", resourceType: "task", resourceId: (p as TaskAssignedPayload).taskId }),
  },
  "task.status_changed": {
    type: "task.status_changed",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as TaskStatusChangedPayload).eventId),
    buildContent: (p) => {
      const t = p as TaskStatusChangedPayload;
      return { title: `Task status: ${t.status}`, resourceType: "task", resourceId: t.taskId };
    },
  },
  "task.due_soon": {
    type: "task.due_soon",
    channels: ["in_app", "email"],
    priority: "urgent",
    buildRecipients: (p) => byEvent((p as TaskDueSoonPayload).eventId),
    buildContent: (p) => {
      const t = p as TaskDueSoonPayload;
      return { title: "Task due soon", body: `Due at ${t.dueAt}`, resourceType: "task", resourceId: t.taskId };
    },
    buildDedupKey: (p) => `task.due_soon:${(p as TaskDueSoonPayload).taskId}`,
  },
  "task.archived": {
    type: "task.archived",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as TaskArchivedPayload).eventId),
    buildContent: (p) => ({ title: "Task archived", resourceType: "task", resourceId: (p as TaskArchivedPayload).taskId }),
  },

  // ---- event ----
  "event.created": {
    type: "event.created",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as EventCreatedPayload).eventId),
    buildContent: (p) => {
      const e = p as EventCreatedPayload;
      return { title: `Event created: ${e.title}`, resourceType: "event", resourceId: e.eventId };
    },
  },
  "event.updated": {
    type: "event.updated",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as EventUpdatedPayload).eventId),
    buildContent: (p) => ({ title: "Event updated", resourceType: "event", resourceId: (p as EventUpdatedPayload).eventId }),
  },
  "event.phase_changed": {
    type: "event.phase_changed",
    channels: ["in_app", "email"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as EventPhaseChangedPayload).eventId),
    buildContent: (p) => {
      const e = p as EventPhaseChangedPayload;
      return { title: `Event phase: ${e.phase}`, resourceType: "event", resourceId: e.eventId };
    },
  },
  "event.archived": {
    type: "event.archived",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as EventArchivedPayload).eventId),
    buildContent: (p) => ({ title: "Event archived", resourceType: "event", resourceId: (p as EventArchivedPayload).eventId }),
  },

  // ---- action ----
  "action.created": {
    type: "action.created",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as ActionCreatedPayload).eventId),
    buildContent: (p) => ({ title: "New action created", resourceType: "action", resourceId: (p as ActionCreatedPayload).actionId }),
  },
  "action.updated": {
    type: "action.updated",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as ActionUpdatedPayload).eventId),
    buildContent: (p) => ({ title: "Action updated", resourceType: "action", resourceId: (p as ActionUpdatedPayload).actionId }),
  },
  "action.status_changed": {
    type: "action.status_changed",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as ActionStatusChangedPayload).eventId),
    buildContent: (p) => ({ title: "Action status changed", resourceType: "action", resourceId: (p as ActionStatusChangedPayload).actionId }),
  },
  "action.archived": {
    type: "action.archived",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => byEvent((p as ActionArchivedPayload).eventId),
    buildContent: (p) => ({ title: "Action archived", resourceType: "action", resourceId: (p as ActionArchivedPayload).actionId }),
  },

  // ---- chat ----
  // A chat @mention becomes an in-app notification for each mentioned user (Slack
  // parity: you get notified when someone @-mentions you, even while you're elsewhere).
  // `mentions` rides the event (chat-service parses the body at post time, author
  // already excluded) so notification never reads chat D1. No mentions -> empty
  // recipients -> a legitimate no-op (design test #3): a plain channel message does NOT
  // ring the bell (the in-app unread badge covers that), only mentions do. in_app only
  // (no email/push storm for every mention).
  "chat.message.created": {
    type: "chat.mention",
    channels: ["in_app"],
    priority: "normal",
    buildRecipients: (p) => {
      const ids = (p as ChatMessageCreatedPayload).mentions;
      return ids && ids.length > 0 ? { userIds: [...ids] } : {};
    },
    buildContent: (p) => ({
      title: "メンションされました",
      resourceType: "channel",
      resourceId: (p as ChatMessageCreatedPayload).channelId,
    }),
  },

  // ---- public inquiry (gateway) — save + notify staff ----
  "public.inquiry.received": {
    type: "public.inquiry.received",
    channels: ["in_app", "email"],
    priority: "urgent", // staff should see inquiries promptly (enables email default)
    audience: "admin", // staff-facing; not shown to general members
    buildRecipients: (): NotifyRecipients => ({ roles: [ROLE_ADMIN, ROLE_ORGANIZER] }),
    buildContent: (p) => {
      const i = p as PublicInquiryReceivedPayload;
      return { title: `New inquiry: ${i.kind}`, body: `From ${i.name} <${i.email}>\n\n${i.message}`, resourceType: "inquiry" };
    },
  },

  // ---- operational alerts (admin only) ----
  // All admin-audience: only admins/maintainers see them until an admin publishes to
  // members via the Notification management screen. "deploy完了" is the auto-admin
  // notification B-set member is expected to publish (Notification管理 §5).
  "github.sync_failed": {
    type: "github.sync_failed",
    channels: ["in_app"],
    priority: "normal",
    audience: "admin",
    buildRecipients: (): NotifyRecipients => ({ roles: [ROLE_ADMIN] }),
    buildContent: (p) => {
      const g = p as GithubSyncFailedPayload;
      return { title: `GitHub sync failed: ${g.scope}`, body: g.error };
    },
  },
  "github.conflict_detected": {
    type: "github.conflict_detected",
    channels: ["in_app"],
    priority: "normal",
    audience: "admin",
    buildRecipients: (): NotifyRecipients => ({ roles: [ROLE_ADMIN] }),
    buildContent: (p) => ({ title: "GitHub conflict detected", resourceType: "task", resourceId: (p as GithubConflictDetectedPayload).taskId }),
  },
  "deploy.deployment.status_changed": {
    type: "deploy.deployment.status_changed",
    channels: ["in_app"],
    priority: "normal",
    audience: "admin", // "デプロイ完了" (auto-admin notification #1) — admin publishes to members
    buildRecipients: (): NotifyRecipients => ({ roles: [ROLE_ADMIN] }),
    buildContent: (p) => {
      const d = p as DeployDeploymentStatusChangedPayload;
      return { title: `Deployment ${d.status}`, resourceType: "deployment", resourceId: d.deploymentId };
    },
  },
  "deploy.dns.record_changed": {
    type: "deploy.dns.record_changed",
    channels: ["in_app"],
    priority: "normal",
    audience: "admin",
    buildRecipients: (): NotifyRecipients => ({ roles: [ROLE_ADMIN] }),
    buildContent: (p) => {
      const d = p as DeployDnsRecordChangedPayload;
      return { title: `DNS changed: ${d.name}`, body: `zone ${d.zone}` };
    },
  },
};
