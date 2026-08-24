// Event payloads. Each row's payload is defined by the producing unit's design;
// @dub/events re-exports them into DubEventPayloadMap (payload = ids + change diff).
import type { common, event, task, notification, drive, deploy } from "@dub/types";

type EventId = common.EventId;
type ActionId = common.ActionId;
type TaskId = common.TaskId;
type UserId = common.UserId;
type ChannelId = common.ChannelId;
type MessageId = common.MessageId;
type FileId = common.FileId;
type DeploymentId = common.DeploymentId;
type ISODateTime = common.ISODateTime;

// ---- event / action ----
export interface EventCreatedPayload { eventId: EventId; title: string; phase: event.EventPhase }
export interface EventUpdatedPayload { eventId: EventId; changed: string[] }
export interface EventPhaseChangedPayload { eventId: EventId; previousPhase: event.EventPhase; phase: event.EventPhase }
export interface EventArchivedPayload { eventId: EventId }
export interface ActionCreatedPayload { actionId: ActionId; eventId: EventId; kind: string }
export interface ActionUpdatedPayload { actionId: ActionId; eventId: EventId; changed: string[] }
export interface ActionStatusChangedPayload { actionId: ActionId; eventId: EventId }
export interface ActionArchivedPayload { actionId: ActionId; eventId: EventId }

// ---- task ----
// eventId is optional: a task may be unlinked to any event (判断44). Consumers that
// fan out by event (notification recipients, gantt cache purge) must treat an absent
// eventId as "no event scope" rather than assume it is always present.
export interface TaskEventContext { taskId: TaskId; eventId?: EventId }
export interface TaskCreatedPayload extends TaskEventContext {}
export interface TaskUpdatedPayload extends TaskEventContext { changed: string[] }
export interface TaskAssignedPayload extends TaskEventContext { assigneeId: UserId | null }
export interface TaskStatusChangedPayload extends TaskEventContext { previousStatus: task.TaskStatus; status: task.TaskStatus }
export interface TaskDueSoonPayload extends TaskEventContext { dueAt: ISODateTime }
export interface TaskArchivedPayload extends TaskEventContext {}
export interface TaskDependencyChangedPayload extends TaskEventContext { added: TaskId[]; removed: TaskId[] }

// ---- send / receive: cross-team task requests + cross-links ----
// The "送る・受け取る" feature (design: docs/design/send-receive-task-requests.md,
// ADR-0007). All additive; frozen event names + payloads unchanged. eventId stays
// optional (a request/link may be unlinked to any event), same as TaskEventContext.
export interface TaskRequestCreatedPayload { requestId: string; fromUserId: UserId; toUserId: UserId; eventId?: EventId }
export interface TaskRequestAcceptedPayload { requestId: string; createdTaskId: TaskId; sourceTaskId?: TaskId; eventId?: EventId }
export interface TaskRequestDeclinedPayload { requestId: string; eventId?: EventId }
export interface TaskRequestCancelledPayload { requestId: string; eventId?: EventId }
export interface TaskCrossLinkCreatedPayload { crossLinkId: string; requesterTaskId: TaskId; requesteeTaskId: TaskId; eventId?: EventId }

// ---- cross-cutting requested / inquiry ----
export interface NotificationRequestedPayload {
  type: notification.NotificationType;
  recipientIds: UserId[];
  title: string;
  body: string;
}
export interface PublicInquiryReceivedPayload { kind: string; name: string; email: string; message: string }

// ---- chat (△ pending 9-C) ----
export interface ChatMessageCreatedPayload { channelId: ChannelId; messageId: MessageId; authorId: UserId }
export interface ChatMessageDeletedPayload { channelId: ChannelId; messageId: MessageId }
export interface ChatChannelCreatedPayload { channelId: ChannelId; name: string }
export interface ChatMemberChangedPayload { channelId: ChannelId; userId: UserId; change: "added" | "removed" }

// ---- file / drive ----
export interface FileRegisteredPayload { fileId: FileId }
export interface FileUpdatedPayload { fileId: FileId }
export interface FileDeletedPayload { fileId: FileId } // deleted-name exception (link removal)
export interface FileLinkedPayload { fileId: FileId; targetType: string; targetId: string }
export interface FileUnlinkedPayload { fileId: FileId; targetType: string; targetId: string }
export interface DriveFileCreatedPayload { driveFileId: drive.DriveFileId }
export interface DriveFileMovedPayload { driveFileId: drive.DriveFileId }
export interface DriveFileTrashedPayload { driveFileId: drive.DriveFileId }
export interface DriveSheetWrittenPayload { driveFileId: drive.DriveFileId; range: string }

// ---- github ----
export interface GithubLinkCreatedPayload { taskId: TaskId; repo: string }
export interface GithubLinkRemovedPayload { taskId: TaskId; repo: string }
export interface GithubSyncCompletedPayload { scope: string }
export interface GithubSyncFailedPayload { scope: string; error: string }
export interface GithubConflictDetectedPayload { taskId: TaskId }

// ---- deploy (operational alerts) ----
export interface DeployDeploymentStatusChangedPayload { deploymentId: DeploymentId; status: deploy.DeploymentStatus }
export interface DeployDnsRecordChangedPayload { zone: string; name: string }

// ---- mail (△ pending 9-B) ----
export interface MailMessageReceivedPayload { messageId: string; threadId: string }
export interface MailMessageSentPayload { messageId: string }
export interface MailMessageSendFailedPayload { messageId: string; error: string }
export interface MailAutomationDecidedPayload { ruleId: string | null; decision: string }
export interface MailAutomationRoutedPayload { messageId: string }
