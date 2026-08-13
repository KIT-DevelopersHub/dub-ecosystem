// Resend collector — email send counts (today / month) from the mail-gateway send log.
// The count logic lives in resend-usage.ts; this maps it into metric keys. Read failures
// yield null -> the key is omitted (metric renders "unknown"). Never throws.
import type { DbClient } from "@dub/db";
import type { Env } from "../env";
import { countResendSends } from "../resend-usage";
import type { Collector, MetricMap } from "./index";

export const resendCollector: Collector = {
  name: "resend",
  async collect(_env: Env, mailDb: DbClient, now: Date): Promise<MetricMap> {
    const counts = await countResendSends(mailDb, now);
    const out: MetricMap = {};
    if (counts.day !== null) out.resend_emails_day = counts.day;
    if (counts.month !== null) out.resend_emails_month = counts.month;
    return out;
  },
};
