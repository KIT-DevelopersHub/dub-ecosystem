import { describe, it, expect } from "vitest";
import { extractVariables, renderTemplate } from "../src/templates";
import { MailAutoErrorCodes } from "../src/errors";
import type { MailTemplate } from "../src/types";

function tpl(over: Partial<MailTemplate>): MailTemplate {
  return {
    id: "t1",
    name: "t",
    subject: over.subject ?? "Hi {{sender_name}}",
    body: over.body ?? "Thanks for contacting {{event_name}}.",
    variables: over.variables ?? [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("templates", () => {
  it("extracts distinct variables", () => {
    expect(extractVariables("{{a}} {{ b }} {{a}}").sort()).toEqual(["a", "b"]);
  });

  it("renders when all variables resolve", () => {
    const out = renderTemplate(tpl({}), { sender_name: "Alice", event_name: "Hackit" });
    expect(out.subject).toBe("Hi Alice");
    expect(out.body).toBe("Thanks for contacting Hackit.");
  });

  it("throws MAILAUTO_TEMPLATE_VAR_MISSING on unresolved variable", () => {
    try {
      renderTemplate(tpl({}), { sender_name: "Alice" }); // event_name missing
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe(MailAutoErrorCodes.TEMPLATE_VAR_MISSING);
    }
  });

  it("declared-but-unused variables are still required present", () => {
    expect(() => renderTemplate(tpl({ subject: "static", body: "static", variables: ["needed"] }), {})).toThrowError();
  });
});
