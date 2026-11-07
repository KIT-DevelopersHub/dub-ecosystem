// mail-gateway のメール集計 (POST /internal/sponsor/contacts, s2s のみ) を呼ぶポート。
// 1 回の呼び出し = subrequest 1 つ (POST なので再試行しない)。失敗は呼び出し側が扱う。
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient } from "@dub/http";
import type { sponsor } from "@dub/types";
import type { MailContactsSource } from "./sponsor-mail-service";

export function mailContactsVia(mail: Fetcher): MailContactsSource {
  const client = createServiceClient(mail, { service: "mail-gateway", caller: "member-service", timeoutMs: 10_000 });
  return {
    async query(ctx, q) {
      const res = await client.post<sponsor.MailContactsResponse, sponsor.MailContactsQuery>(ctx, "/internal/sponsor/contacts", q);
      return res.contacts ?? [];
    },
  };
}
