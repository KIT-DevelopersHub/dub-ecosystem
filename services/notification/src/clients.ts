// Outbound ports + their Service-Binding-backed implementations. Every downstream
// dependency is expressed as a narrow port so the delivery core stays testable with
// in-memory fakes and so mail/chat/push can be swapped in unchanged at the infra波
// (design test #14 — implementation交換 without touching the core).
import { createServiceClient } from "@dub/http";
import type { RequestContext } from "@dub/http";
import type { Fetcher } from "@cloudflare/workers-types";
import type { identity, mail } from "@dub/types";
import { SERVICE_NAME } from "./config";

// ---- identity ----
export interface IdentityPort {
  /** GET /users?roleKey= — expand a role key into member user ids. */
  listUserIdsByRole(roleKey: string, ctx: RequestContext): Promise<string[]>;
  /** GET /users/:id — resolve a user's email (null when absent/unknown). */
  getEmail(userId: string, ctx: RequestContext): Promise<string | null>;
}

// ---- event ----
export interface EventPort {
  /** GET /events/:id/participants — organizers assigned to the event's work. */
  listParticipantIds(eventId: string, ctx: RequestContext): Promise<string[]>;
}

// ---- mail-gateway (EmailAdapter) ----
export interface MailPort {
  send(req: mail.SendMailRequest, idempotencyKey: string, ctx: RequestContext): Promise<void>;
}

// ---- chat-service (ChatAdapter) ----
export interface ChatSystemMessage {
  userId: string;
  title: string;
  body: string | null;
}
export interface ChatPort {
  postSystemMessage(msg: ChatSystemMessage, ctx: RequestContext): Promise<void>;
}

// ---- mobile-bff (PushAdapter) ----
export interface PushDispatch {
  userId: string;
  type: string;
  title: string;
  body: string | null;
}
export interface PushPort {
  dispatch(req: PushDispatch, ctx: RequestContext): Promise<void>;
}

// ---------- real implementations ----------

export function makeIdentityPort(binding: Fetcher): IdentityPort {
  const client = createServiceClient(binding, { service: "identity-roster", caller: SERVICE_NAME });
  return {
    async listUserIdsByRole(roleKey, ctx) {
      const res = await client.get<{ items: { id: string }[] }>(ctx, "/users", { query: { roleKey } });
      return res.items.map((u) => u.id);
    },
    async getEmail(userId, ctx) {
      const user = await client.get<identity.IdentityUser>(ctx, `/users/${encodeURIComponent(userId)}`);
      return user.email ?? null;
    },
  };
}

export function makeEventPort(binding: Fetcher): EventPort {
  const client = createServiceClient(binding, { service: "event-service", caller: SERVICE_NAME });
  return {
    async listParticipantIds(eventId, ctx) {
      const res = await client.get<{ userIds: string[] }>(
        ctx,
        `/events/${encodeURIComponent(eventId)}/participants`,
      );
      return res.userIds;
    },
  };
}

export function makeMailPort(binding: Fetcher): MailPort {
  const client = createServiceClient(binding, { service: "mail-gateway", caller: SERVICE_NAME });
  return {
    async send(req, idempotencyKey, ctx) {
      await client.post<mail.SendMailResponse, mail.SendMailRequest>(ctx, "/send", req, { idempotencyKey });
    },
  };
}

export function makeChatPort(binding: Fetcher): ChatPort {
  const client = createServiceClient(binding, { service: "chat-service", caller: SERVICE_NAME });
  return {
    async postSystemMessage(msg, ctx) {
      await client.post(ctx, "/internal/system-messages", msg);
    },
  };
}

export function makePushPort(binding: Fetcher): PushPort {
  const client = createServiceClient(binding, { service: "mobile-bff", caller: SERVICE_NAME });
  return {
    async dispatch(req, ctx) {
      await client.post(ctx, "/internal/push/dispatch", req);
    },
  };
}
