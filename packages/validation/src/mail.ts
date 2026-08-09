// mail-gateway SendMailRequest validator (mail.SendMailRequest, theme15 frozen ①).
// Recipients must be a non-empty array of {email, name?}; subject + textBody are
// required. Per-recipient failures carry an indexed field ("to[2].email") so FE can
// point at the offending row.
import { invalidField, FieldCollector } from "./collector";
import { isEmail, isPlainObject, isString } from "./primitives";
import type { mail } from "@dub/types";

const SUBJECT_MAX = 998; // RFC 5322 unfolded header line practical ceiling

function checkAddressList(
  c: FieldCollector,
  field: string,
  value: unknown,
  required: boolean,
): void {
  if (value === undefined) {
    if (required) c.add(field, "required");
    return;
  }
  if (!Array.isArray(value)) {
    c.add(field, "invalid_type", `${field} must be an array of addresses`);
    return;
  }
  if (required && value.length === 0) {
    c.add(field, "empty", `${field} must have at least one recipient`);
    return;
  }
  value.forEach((addr, i) => {
    const at = `${field}[${i}]`;
    if (!isPlainObject(addr)) {
      c.add(at, "invalid_type", `${at} must be an object`);
      return;
    }
    if (!isEmail(addr.email)) c.add(`${at}.email`, "invalid_format", "invalid email address");
    if (addr.name !== undefined && !isString(addr.name)) {
      c.add(`${at}.name`, "invalid_type", `${at}.name must be a string`);
    }
  });
}

/**
 * Validate a SendMailRequest body. Throws VALIDATION_FAILED with all field errors.
 * Loop-prevention header stamping (MailLoopHeaders) is the gateway's runtime
 * concern; here loopHeaders is only shape-checked when present.
 */
export function validateSendMailRequest(body: unknown): mail.SendMailRequest {
  if (!isPlainObject(body)) throw invalidField("(root)", "invalid_type");
  const c = new FieldCollector();

  checkAddressList(c, "to", body.to, true);
  checkAddressList(c, "cc", body.cc, false);

  c.requireNonEmptyString("subject", body.subject, SUBJECT_MAX);
  c.requireString("textBody", body.textBody);
  c.optionalString("htmlBody", body.htmlBody);
  c.optionalString("inReplyTo", body.inReplyTo);

  if (body.loopHeaders !== undefined && !isPlainObject(body.loopHeaders)) {
    c.add("loopHeaders", "invalid_type", "loopHeaders must be an object");
  }

  c.throwIfInvalid();
  return body as unknown as mail.SendMailRequest;
}
