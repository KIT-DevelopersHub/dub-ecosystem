// Chat DM in-app notification. Mirrors the @mention fan-out in mapping.ts
// ("chat.message.created" -> chat.mention) but keyed off `isDm` / `dmRecipientIds`
// (populated by chat-service only for "dm"-type channels) instead of `<@id>` mentions.
//
// Kept as a bespoke builder rather than a second EventMappingRule: a mapping rule
// carries exactly one static `type` (see types.ts), but a single chat.message.created
// event can independently need BOTH the existing @mention notification and this DM
// notification (different `type`, different recipient set). queue.ts layers this
// builder onto the generated @mention handler so both run off the one event.
import type { DubEventEnvelope } from "@dub/events";
import { CHAT_DM_NOTIFY_TYPE } from "./config";
import type { IngestInput } from "./types";

const DM_TITLE = "ダイレクトメッセージが届きました";

/**
 * Build the DM in-app notification for a chat.message.created event, or null when the
 * message wasn't posted into a DM channel / had no other member to notify (author-only
 * DM row, or an older publisher that omits the additive isDm/dmRecipientIds fields) —
 * both legitimate no-ops, same contract as the @mention rule's empty-recipients case.
 */
export function buildChatDmNotifyInput(env: DubEventEnvelope<"chat.message.created">): IngestInput | null {
  const p = env.payload;
  if (!p.isDm) return null;
  const recipients = (p.dmRecipientIds ?? []).filter((uid) => uid !== p.authorId);
  if (recipients.length === 0) return null;
  return {
    type: CHAT_DM_NOTIFY_TYPE,
    recipients: { userIds: [...recipients] },
    title: DM_TITLE,
    body: null,
    priority: "normal",
    channels: ["in_app"],
    dedupKey: `chat.dm:${p.messageId}`,
    resourceType: "channel",
    resourceId: p.channelId,
    source: "queue",
    sourceEvent: env.name,
    actorId: env.actorId,
    requestId: env.requestId,
  };
}
