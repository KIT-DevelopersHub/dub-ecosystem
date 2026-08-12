// Recipient resolution (design §1 two-stage): direct userIds + roles (identity) +
// eventId (event-service). Results are de-duplicated. roles AND eventId compose by
// union (a user reachable via either spec is a recipient). An empty result is a
// legitimate no-op, never an error (design test #3).
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { EventPort, IdentityPort } from "./clients";
import type { NotifyRecipients } from "./types";

export interface RecipientResolver {
  resolve(recipients: NotifyRecipients, ctx: RequestContext): Promise<string[]>;
}

export function makeRecipientResolver(deps: { identity: IdentityPort; event: EventPort }): RecipientResolver {
  return {
    async resolve(recipients, ctx) {
      const set = new Set<string>();

      for (const id of recipients.userIds ?? []) set.add(id);

      try {
        // Broadcast: every active user (release notes / org-wide announcements).
        if (recipients.all) {
          const ids = await deps.identity.listAllUserIds(ctx);
          for (const id of ids) set.add(id);
        }
        for (const roleKey of recipients.roles ?? []) {
          const ids = await deps.identity.listUserIdsByRole(roleKey, ctx);
          for (const id of ids) set.add(id);
        }
        if (recipients.eventId) {
          const ids = await deps.event.listParticipantIds(recipients.eventId, ctx);
          for (const id of ids) set.add(id);
        }
      } catch (cause) {
        // Synchronous expansion failure surfaces as 502 (design §6). The delivery
        // stage's own failures are recorded, not thrown.
        throw new DubError(
          "NOTIF_RECIPIENT_RESOLUTION_FAILED",
          "failed to expand notification recipients",
          { status: 502, cause, retryable: true },
        );
      }

      return [...set];
    },
  };
}

export const RECIPIENT_RESOLUTION_FAILED = "NOTIF_RECIPIENT_RESOLUTION_FAILED";
export const RECIPIENT_UPSTREAM_CODE = CommonErrorCodes.UPSTREAM_UNAVAILABLE;
