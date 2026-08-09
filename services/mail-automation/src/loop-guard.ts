// Pure loop-prevention guards (header-based + self-sender). Thread/rate guards that
// need persisted counts live in the pipeline; these are the stateless checks.
import type { InboundMail } from "./types";

const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);

function header(mail: InboundMail, name: string): string | undefined {
  return mail.headers?.[name.toLowerCase()];
}

/**
 * Header-based auto-mail detection (RFC 3834 + common bulk markers):
 *  - Auto-Submitted present and not "no"
 *  - Precedence: bulk | list | junk
 *  - List-Id present (mailing list)
 * Returns a reason string when the message looks automated, else null.
 */
export function headerLoopReason(mail: InboundMail): string | null {
  const autoSubmitted = header(mail, "auto-submitted");
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== "no") return "auto_submitted";
  const precedence = header(mail, "precedence");
  if (precedence && BULK_PRECEDENCE.has(precedence.trim().toLowerCase())) return "precedence_bulk";
  if (header(mail, "list-id")) return "list_id_present";
  return null;
}

/** Sender is one of our own auto-send addresses/domains (reply-to-our-own-reply). */
export function selfSenderReason(
  mail: InboundMail,
  selfAddresses: readonly string[],
  selfDomains: readonly string[],
): string | null {
  const from = mail.from.email.toLowerCase();
  if (selfAddresses.some((a) => a.toLowerCase() === from)) return "self_address";
  const at = from.lastIndexOf("@");
  const domain = at >= 0 ? from.slice(at + 1) : "";
  if (selfDomains.some((d) => d.toLowerCase() === domain)) return "self_domain";
  return null;
}
