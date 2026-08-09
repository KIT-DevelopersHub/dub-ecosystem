import { describe, expect, it } from "vitest";
import type { PreferenceEntry } from "../src/contracts/notification-api";
import {
  diffPreferences,
  matchSpecificity,
  mergePreferences,
  parsePattern,
  resolveEffectiveChannels,
  toggleChannel,
} from "../src/lib/preference-merge";

describe("parsePattern", () => {
  it("classifies all / prefix / exact", () => {
    expect(parsePattern("*")).toEqual({ kind: "all" });
    expect(parsePattern("task.*")).toEqual({ kind: "prefix", prefix: "task." });
    expect(parsePattern("task.")).toEqual({ kind: "prefix", prefix: "task." });
    expect(parsePattern("task.assigned")).toEqual({ kind: "exact", value: "task.assigned" });
  });
});

describe("matchSpecificity", () => {
  it("ranks exact > prefix > wildcard, and non-matches return -1", () => {
    const t = "task.assigned";
    const exact = matchSpecificity("task.assigned", t);
    const prefix = matchSpecificity("task.*", t);
    const all = matchSpecificity("*", t);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(all);
    expect(all).toBe(0);
    expect(matchSpecificity("event.*", t)).toBe(-1);
  });
});

describe("resolveEffectiveChannels (longest match, override wins)", () => {
  const defaults: PreferenceEntry[] = [
    { type: "*", channels: ["in_app"] },
    { type: "task.*", channels: ["in_app", "push"] },
    { type: "task.assigned", channels: ["in_app", "email"] },
  ];

  it("picks the most specific matching entry", () => {
    expect(resolveEffectiveChannels("task.assigned", defaults, [])).toEqual(["in_app", "email"]);
    expect(resolveEffectiveChannels("task.other", defaults, [])).toEqual(["in_app", "push"]);
    expect(resolveEffectiveChannels("system.foo", defaults, [])).toEqual(["in_app"]);
  });

  it("override wins on equal specificity", () => {
    const overrides: PreferenceEntry[] = [{ type: "task.assigned", channels: ["push"] }];
    expect(resolveEffectiveChannels("task.assigned", defaults, overrides)).toEqual(["push"]);
  });

  it("a more specific default still beats a less specific override", () => {
    const overrides: PreferenceEntry[] = [{ type: "*", channels: ["email"] }];
    // task.assigned exact default is more specific than the "*" override.
    expect(resolveEffectiveChannels("task.assigned", defaults, overrides)).toEqual(["in_app", "email"]);
  });
});

describe("mergePreferences", () => {
  it("override replaces the default row and flags overridden; extra overrides append", () => {
    const defaults: PreferenceEntry[] = [
      { type: "*", channels: ["in_app"] },
      { type: "task.*", channels: ["in_app", "push"] },
    ];
    const overrides: PreferenceEntry[] = [
      { type: "task.*", channels: ["in_app"] },
      { type: "event.invited", channels: ["email"] },
    ];
    const rows = mergePreferences(defaults, overrides);
    const taskRow = rows.find((r) => r.type === "task.*")!;
    expect(taskRow.channels).toEqual(["in_app"]);
    expect(taskRow.overridden).toBe(true);
    expect(taskRow.source).toBe("override");
    const starRow = rows.find((r) => r.type === "*")!;
    expect(starRow.overridden).toBe(false);
    expect(rows.some((r) => r.type === "event.invited")).toBe(true);
  });
});

describe("diffPreferences", () => {
  it("returns only rows whose channel set changed (order-independent)", () => {
    const base = mergePreferences(
      [
        { type: "*", channels: ["in_app"] },
        { type: "task.*", channels: ["in_app", "push"] },
      ],
      [],
    );
    const edited = base.map((r) =>
      r.type === "task.*" ? toggleChannel(r, "email") : r,
    );
    const diff = diffPreferences(base, edited);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.type).toBe("task.*");
    expect(new Set(diff[0]!.channels)).toEqual(new Set(["in_app", "push", "email"]));
  });

  it("reordering channels alone is not a diff", () => {
    const base = mergePreferences([{ type: "*", channels: ["in_app", "push"] }], []);
    const edited = base.map((r) => ({ ...r, channels: ["push", "in_app"] as PreferenceEntry["channels"] }));
    expect(diffPreferences(base, edited)).toHaveLength(0);
  });
});

describe("toggleChannel", () => {
  it("adds then removes a channel and marks the row as an override", () => {
    const [row] = mergePreferences([{ type: "*", channels: ["in_app"] }], []);
    const added = toggleChannel(row!, "push");
    expect(added.channels).toContain("push");
    expect(added.overridden).toBe(true);
    const removed = toggleChannel(added, "push");
    expect(removed.channels).not.toContain("push");
  });
});
