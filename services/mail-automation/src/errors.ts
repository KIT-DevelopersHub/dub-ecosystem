// Service-specific error codes (MAILAUTO_ prefix). Common events reuse @dub/errors
// CommonErrorCodes (VALIDATION_FAILED / FORBIDDEN / UPSTREAM_UNAVAILABLE / …).
import { DubError } from "@dub/errors";

export const MailAutoErrorCodes = {
  INVALID_RULE: "MAILAUTO_INVALID_RULE", // 400
  TEMPLATE_VAR_MISSING: "MAILAUTO_TEMPLATE_VAR_MISSING", // 400
  RULE_NOT_FOUND: "MAILAUTO_RULE_NOT_FOUND", // 404
  TEMPLATE_NOT_FOUND: "MAILAUTO_TEMPLATE_NOT_FOUND", // 404
  DUPLICATE_MESSAGE: "MAILAUTO_DUPLICATE_MESSAGE", // 409
  RULE_REFERENCES_MISSING_TEMPLATE: "MAILAUTO_RULE_REFERENCES_MISSING_TEMPLATE", // 422
} as const;
export type MailAutoErrorCode = (typeof MailAutoErrorCodes)[keyof typeof MailAutoErrorCodes];

export function invalidRule(message: string): DubError {
  return new DubError(MailAutoErrorCodes.INVALID_RULE, message, { status: 400 });
}
export function templateVarMissing(missing: string[]): DubError {
  return new DubError(MailAutoErrorCodes.TEMPLATE_VAR_MISSING, `Unresolved template variables: ${missing.join(", ")}`, {
    status: 400,
    details: { missing },
  });
}
export function ruleNotFound(id: string): DubError {
  return new DubError(MailAutoErrorCodes.RULE_NOT_FOUND, `Rule not found: ${id}`, { status: 404 });
}
export function templateNotFound(id: string): DubError {
  return new DubError(MailAutoErrorCodes.TEMPLATE_NOT_FOUND, `Template not found: ${id}`, { status: 404 });
}
export function duplicateMessage(id: string): DubError {
  return new DubError(MailAutoErrorCodes.DUPLICATE_MESSAGE, `Message already processed: ${id}`, { status: 409 });
}
export function ruleReferencesMissingTemplate(templateId: string): DubError {
  return new DubError(MailAutoErrorCodes.RULE_REFERENCES_MISSING_TEMPLATE, `Reply rule references missing template: ${templateId}`, {
    status: 422,
  });
}
