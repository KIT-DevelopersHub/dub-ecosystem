import { describe, expect, it } from "vitest";
import {
  resolveTypeDisplay,
  resolveCategory,
  matchesCategoryFilter,
} from "../src/lib/type-dictionary";

describe("resolveTypeDisplay", () => {
  it("resolves a known exact type to its label + icon", () => {
    const d = resolveTypeDisplay("task.assigned");
    expect(d.known).toBe(true);
    expect(d.icon).toBe("task");
    expect(d.group).toBe("task");
    expect(d.label).toMatch(/assigned/i);
  });

  it("falls back to the group prefix label when only the prefix is known", () => {
    const d = resolveTypeDisplay("task.some_new_type");
    expect(d.known).toBe(true); // task.* matched
    expect(d.group).toBe("task");
    expect(d.icon).toBe("task");
  });

  it("uses the raw string + generic icon for fully unknown types (never crashes)", () => {
    const d = resolveTypeDisplay("weird.unknown.type");
    expect(d.known).toBe(false);
    expect(d.label).toBe("weird.unknown.type");
    expect(d.icon).toBe("bell");
  });

  it("system.announcement gets the megaphone icon", () => {
    expect(resolveTypeDisplay("system.announcement").icon).toBe("megaphone");
  });

  it("release notes resolve to the 🎉 新機能 badge in their own group", () => {
    const d = resolveTypeDisplay("release");
    expect(d.known).toBe(true);
    expect(d.group).toBe("release");
    expect(d.icon).toBe("megaphone");
    expect(d.label).toContain("新機能");
  });
});

describe("resolveCategory (server type -> tab category)", () => {
  it("maps participation submissions to 参加届", () => {
    expect(resolveCategory("member.participation.submitted")).toBe("participation");
  });

  it("maps mail.* to メール", () => {
    expect(resolveCategory("mail.message.received")).toBe("mail");
    expect(resolveCategory("mail.message.sent")).toBe("mail");
  });

  it("maps deploy.* and release/release.* to アプリアップデート", () => {
    expect(resolveCategory("deploy.deployment.status_changed")).toBe("app_update");
    expect(resolveCategory("release")).toBe("app_update");
    expect(resolveCategory("release.notes")).toBe("app_update");
  });

  it("maps feedback/feedback.* to フィードバック", () => {
    expect(resolveCategory("feedback")).toBe("feedback");
    expect(resolveCategory("feedback.submitted")).toBe("feedback");
    // guard against a non-namespaced near-match ("feedbackish" is not feedback)
    expect(resolveCategory("feedbackish")).toBe("other");
  });

  it("does not misclassify a non-namespaced near-match", () => {
    // "released.foo" must NOT be treated as release.*
    expect(resolveCategory("released.foo")).toBe("other");
  });

  it("falls back to other for tasks/events/system/unknown", () => {
    expect(resolveCategory("task.assigned")).toBe("other");
    expect(resolveCategory("event.invited")).toBe("other");
    expect(resolveCategory("system.announcement")).toBe("other");
    expect(resolveCategory("weird.unknown.type")).toBe("other");
  });

  it("matchesCategoryFilter: 'all' matches everything, else exact category", () => {
    expect(matchesCategoryFilter("task.assigned", "all")).toBe(true);
    expect(matchesCategoryFilter("mail.message.received", "mail")).toBe(true);
    expect(matchesCategoryFilter("task.assigned", "mail")).toBe(false);
  });
});
