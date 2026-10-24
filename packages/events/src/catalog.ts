// Event catalog (frozen). Envelope + payload map + pub/sub table + queue topology.
import type {
  EventCreatedPayload, EventUpdatedPayload, EventPhaseChangedPayload, EventArchivedPayload,
  ActionCreatedPayload, ActionUpdatedPayload, ActionStatusChangedPayload, ActionArchivedPayload,
  TaskCreatedPayload, TaskUpdatedPayload, TaskAssignedPayload, TaskStatusChangedPayload,
  TaskDueSoonPayload, TaskArchivedPayload, TaskDependencyChangedPayload,
  TaskRequestCreatedPayload, TaskRequestAcceptedPayload, TaskRequestDeclinedPayload,
  TaskRequestCancelledPayload, TaskCrossLinkCreatedPayload,
  NotificationRequestedPayload, PublicInquiryReceivedPayload,
  ChatMessageCreatedPayload, ChatMessageDeletedPayload, ChatChannelCreatedPayload, ChatMemberChangedPayload,
  FileRegisteredPayload, FileUpdatedPayload, FileDeletedPayload, FileLinkedPayload, FileUnlinkedPayload,
  DriveFileCreatedPayload, DriveFileMovedPayload, DriveFileTrashedPayload, DriveSheetWrittenPayload,
  GithubLinkCreatedPayload, GithubLinkRemovedPayload, GithubSyncCompletedPayload, GithubSyncFailedPayload, GithubConflictDetectedPayload,
  DeployDeploymentStatusChangedPayload, DeployDnsRecordChangedPayload,
  MailMessageReceivedPayload, MailMessageSentPayload, MailMessageSendFailedPayload,
  MailAutomationDecidedPayload, MailAutomationRoutedPayload,
} from "./payloads";

// canonical envelope (frozen: theme#1 decision 1). requestId (E1 resolved), no .v1 suffix.
export interface DubEventEnvelope<N extends DubEventName = DubEventName> {
  name: N; // catalog key, e.g. "task.created"
  version: number; // starts at 1; bump per name on breaking change
  id: string; // ULID, producer-assigned; consumer idempotency key
  occurredAt: string; // ISO 8601 UTC
  requestId: string; // from x-dub-request-id (dubCtx.requestId)
  actorId: string | null; // null = system (cron/webhook)
  payload: DubEventPayloadMap[N];
}

export interface DubEventPayloadMap {
  "event.created": EventCreatedPayload;
  "event.updated": EventUpdatedPayload;
  "event.phase_changed": EventPhaseChangedPayload;
  "event.archived": EventArchivedPayload;
  "action.created": ActionCreatedPayload;
  "action.updated": ActionUpdatedPayload;
  "action.status_changed": ActionStatusChangedPayload;
  "action.archived": ActionArchivedPayload;
  "task.created": TaskCreatedPayload;
  "task.updated": TaskUpdatedPayload;
  "task.assigned": TaskAssignedPayload;
  "task.status_changed": TaskStatusChangedPayload;
  "task.due_soon": TaskDueSoonPayload;
  "task.archived": TaskArchivedPayload;
  "task.dependency_changed": TaskDependencyChangedPayload;
  "task.request.created": TaskRequestCreatedPayload;
  "task.request.accepted": TaskRequestAcceptedPayload;
  "task.request.declined": TaskRequestDeclinedPayload;
  "task.request.cancelled": TaskRequestCancelledPayload;
  "task.cross_link.created": TaskCrossLinkCreatedPayload;
  "notification.requested": NotificationRequestedPayload;
  "public.inquiry.received": PublicInquiryReceivedPayload;
  "chat.message.created": ChatMessageCreatedPayload;
  "chat.message.deleted": ChatMessageDeletedPayload;
  "chat.channel.created": ChatChannelCreatedPayload;
  "chat.member.added": ChatMemberChangedPayload;
  "chat.member.removed": ChatMemberChangedPayload;
  "file.registered": FileRegisteredPayload;
  "file.updated": FileUpdatedPayload;
  "file.deleted": FileDeletedPayload;
  "file.linked": FileLinkedPayload;
  "file.unlinked": FileUnlinkedPayload;
  "drive.file.created": DriveFileCreatedPayload;
  "drive.file.moved": DriveFileMovedPayload;
  "drive.file.trashed": DriveFileTrashedPayload;
  "drive.sheet.written": DriveSheetWrittenPayload;
  "github.link_created": GithubLinkCreatedPayload;
  "github.link_removed": GithubLinkRemovedPayload;
  "github.sync_completed": GithubSyncCompletedPayload;
  "github.sync_failed": GithubSyncFailedPayload;
  "github.conflict_detected": GithubConflictDetectedPayload;
  "deploy.deployment.status_changed": DeployDeploymentStatusChangedPayload;
  "deploy.dns.record_changed": DeployDnsRecordChangedPayload;
  "mail.message.received": MailMessageReceivedPayload;
  "mail.message.sent": MailMessageSentPayload;
  "mail.message.send_failed": MailMessageSendFailedPayload;
  "mail.automation.decided": MailAutomationDecidedPayload;
  "mail.automation.routed": MailAutomationRoutedPayload;
}

export type DubEventName = keyof DubEventPayloadMap;

export type ConsumerService =
  | "notification"
  | "task"
  | "gantt"
  | "file-meta"
  | "github-sync"
  | "mail-automation"
  | "mobile-bff";

// consumer -> queue binding name (theme#1 decision6; Queue names use dub-q- prefix).
export const CONSUMER_QUEUE_BINDINGS = {
  notification: "EVT_NOTIFICATION",
  task: "EVT_TASK",
  gantt: "EVT_GANTT",
  "file-meta": "EVT_FILE_META",
  "github-sync": "EVT_GITHUB_SYNC",
  "mail-automation": "EVT_MAIL_AUTOMATION",
  "mobile-bff": "EVT_MOBILE_BFF",
} as const satisfies Record<ConsumerService, string>;

// pub/sub table = routing config. Table change = contract change.
export const SUBSCRIPTIONS = {
  "event.created": ["notification", "mobile-bff"],
  "event.updated": ["notification", "gantt", "mobile-bff"],
  "event.phase_changed": ["notification", "task", "gantt", "mobile-bff"],
  "event.archived": ["notification", "task", "gantt", "github-sync", "file-meta", "mobile-bff"],
  "action.created": ["notification", "task", "gantt", "mobile-bff"],
  "action.updated": ["notification", "gantt", "mobile-bff"],
  "action.status_changed": ["notification", "gantt", "mobile-bff"],
  "action.archived": ["notification", "task", "gantt", "file-meta", "mobile-bff"],
  "task.created": ["notification", "github-sync", "gantt", "mobile-bff"],
  "task.updated": ["github-sync", "gantt", "mobile-bff"],
  "task.assigned": ["notification", "github-sync", "gantt", "mobile-bff"],
  "task.status_changed": ["notification", "github-sync", "gantt", "mobile-bff"],
  "task.due_soon": ["notification", "mobile-bff"],
  "task.archived": ["notification", "github-sync", "gantt", "file-meta", "mobile-bff"],
  "task.dependency_changed": ["gantt"],
  // send / receive (ADR-0007). request lifecycle → notify (+mobile); accept/cross_link
  // also feed gantt so it can project the arrow-less crossTeamRole (no dependency line).
  "task.request.created": ["notification", "mobile-bff"],
  "task.request.accepted": ["notification", "gantt", "mobile-bff"],
  "task.request.declined": ["notification", "mobile-bff"],
  "task.request.cancelled": ["notification", "mobile-bff"],
  "task.cross_link.created": ["gantt", "mobile-bff"],
  "notification.requested": ["notification"],
  "public.inquiry.received": ["notification"],
  "chat.message.created": ["notification"],
  "chat.message.deleted": ["notification"],
  "chat.channel.created": ["notification"],
  "chat.member.added": ["notification"],
  "chat.member.removed": ["notification"],
  "file.registered": [],
  "file.updated": [],
  "file.deleted": [],
  "file.linked": [],
  "file.unlinked": [],
  "drive.file.created": ["file-meta"],
  "drive.file.moved": ["file-meta"],
  "drive.file.trashed": ["file-meta"],
  "drive.sheet.written": [],
  "github.link_created": [],
  "github.link_removed": [],
  "github.sync_completed": [],
  "github.sync_failed": ["notification"],
  "github.conflict_detected": ["notification"],
  "deploy.deployment.status_changed": ["notification"],
  "deploy.dns.record_changed": ["notification"],
  "mail.message.received": ["mail-automation"],
  "mail.message.sent": ["notification"],
  "mail.message.send_failed": ["notification"],
  "mail.automation.decided": ["notification"],
  "mail.automation.routed": ["notification"],
} as const satisfies Record<DubEventName, readonly ConsumerService[]>;
