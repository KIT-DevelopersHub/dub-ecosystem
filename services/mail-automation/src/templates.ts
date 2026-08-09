// Pure template rendering: {{var}} substitution with unresolved-variable detection.
import type { MailTemplate } from "./types";
import { templateVarMissing } from "./errors";

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Distinct {{var}} tokens referenced in a string. */
export function extractVariables(text: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(text)) !== null) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

function substitute(text: string, ctx: Record<string, string>): string {
  return text.replace(VAR_RE, (_full, name: string) => ctx[name] ?? "");
}

export interface RenderedTemplate {
  subject: string;
  body: string;
}

/**
 * Render subject+body against `ctx`. Any referenced (or declared) variable that is
 * absent from ctx throws MAILAUTO_TEMPLATE_VAR_MISSING — the caller must NOT send.
 */
export function renderTemplate(template: MailTemplate, ctx: Record<string, string>): RenderedTemplate {
  const referenced = new Set<string>([
    ...extractVariables(template.subject),
    ...extractVariables(template.body),
    ...template.variables,
  ]);
  const missing = [...referenced].filter((v) => ctx[v] === undefined);
  if (missing.length > 0) throw templateVarMissing(missing);
  return { subject: substitute(template.subject, ctx), body: substitute(template.body, ctx) };
}
