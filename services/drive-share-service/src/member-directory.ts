// 名簿 Gmail lookup via the member-service Service Binding (POST /members/internal/google-emails).
// カレンダー > ミーティング invites each member at their 名簿 Gmail (a Google account, so the event
// lands in their own calendar), falling back to their Dub login address. Never fails a meeting:
// a missing binding or a member-service error simply means "no Gmail known for anyone".
import { createServiceClient, type RequestContext } from "@dub/http";
import type { Fetcher } from "@cloudflare/workers-types";

export interface MemberGoogleInfo {
  gmail: string | null;
  name: string;
}

export interface MemberDirectory {
  /** userId -> 名簿 info, for the linked rows only. */
  googleEmails(userIds: readonly string[]): Promise<Map<string, MemberGoogleInfo>>;
}

interface GoogleEmailsResponse {
  items: { userId: string; gmail: string | null; name: string }[];
}

export function createMemberDirectory(binding: Fetcher | undefined, ctx: RequestContext): MemberDirectory {
  return {
    async googleEmails(userIds) {
      const out = new Map<string, MemberGoogleInfo>();
      if (!binding || userIds.length === 0) return out;
      try {
        const client = createServiceClient(binding, { service: "member-service", caller: "drive-share-service" });
        const res = await client.post<GoogleEmailsResponse>(ctx, "/members/internal/google-emails", { userIds: [...userIds] });
        for (const it of res.items ?? []) {
          const gmail = typeof it.gmail === "string" && it.gmail.includes("@") ? it.gmail.trim().toLowerCase() : null;
          out.set(it.userId, { gmail, name: it.name });
        }
      } catch (err) {
        console.warn(JSON.stringify({ service: "drive-share-service", event: "member_google_emails_failed", message: err instanceof Error ? err.message : String(err) }));
      }
      return out;
    },
  };
}

/** Static directory for tests / wiring without member-service. */
export function staticMemberDirectory(entries: Record<string, MemberGoogleInfo> = {}): MemberDirectory {
  return {
    async googleEmails(userIds) {
      return new Map(userIds.filter((id) => id in entries).map((id) => [id, entries[id]!]));
    },
  };
}
