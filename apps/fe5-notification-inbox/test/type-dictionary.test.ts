import { describe, expect, it } from "vitest";
import { resolveTypeDisplay } from "../src/lib/type-dictionary";

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
