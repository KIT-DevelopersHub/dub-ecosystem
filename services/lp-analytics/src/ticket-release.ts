// チケットの販売状態（release のうち ticketsEnabled / ticketsCtaEnabled）は lp-tickets の D1 が正本。
// 公開設定はここを通して読み書きする（SVC_LP_TICKETS・INTERNAL ルート）。
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient } from "@dub/http";
import type { TicketRelease, TicketReleaseClient } from "./types";

const PATH = "/lp/internal/tickets/release";

export function createTicketReleaseClient(binding: Fetcher, requestId: string): TicketReleaseClient {
  const client = createServiceClient(binding, { service: "lp-tickets", caller: "lp-analytics" });
  return {
    get: () => client.get<TicketRelease>({ requestId }, PATH),
    async set(release, updatedBy) {
      // 同じ値の再送は何も変えない（冪等）ので POST でも retry してよい。
      await client.post<TicketRelease>({ requestId, userId: updatedBy }, PATH, release, { retry: {} });
    },
  };
}
