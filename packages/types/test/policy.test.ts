// Policy layer (PDP) contract tests. The whole point of this module is that EVERY
// consumer — services, shell flags, ロール管理 UI — agrees on one derivation of the
// 無効/閲覧/編集 level, and that a newly registered app is covered without anyone editing a
// list. These tests pin both properties.
import { describe, it, expect } from "vitest";
import { identity, appRegistry, policy } from "../src/index";

type Key = identity.PermissionKey;

describe("AppAccessLevel — the 3 段階 enum", () => {
  it("is ordered none < view < edit", () => {
    expect(policy.APP_ACCESS_LEVELS).toEqual(["none", "view", "edit"]);
    expect(policy.levelRank("none")).toBeLessThan(policy.levelRank("view"));
    expect(policy.levelRank("view")).toBeLessThan(policy.levelRank("edit"));
  });

  it("edit satisfies a view requirement; view never satisfies edit", () => {
    expect(policy.levelAtLeast("edit", "view")).toBe(true);
    expect(policy.levelAtLeast("view", "view")).toBe(true);
    expect(policy.levelAtLeast("view", "edit")).toBe(false);
    expect(policy.levelAtLeast("none", "view")).toBe(false);
    // `none` is still a satisfiable requirement (level none required = always ok)
    expect(policy.levelAtLeast("none", "none")).toBe(true);
  });

  it("guards wire values", () => {
    expect(policy.isAppAccessLevel("edit")).toBe(true);
    expect(policy.isAppAccessLevel("EDIT")).toBe(false);
    expect(policy.isAppAccessLevel(undefined)).toBe(false);
  });

  it("maps HTTP methods to the level they demand", () => {
    expect(policy.levelForMethod("GET")).toBe("view");
    expect(policy.levelForMethod("head")).toBe("view");
    expect(policy.levelForMethod("POST")).toBe("edit");
    expect(policy.levelForMethod("PATCH")).toBe("edit");
    expect(policy.levelForMethod("DELETE")).toBe("edit");
  });

  it("labels every level (no blank cell in the 一覧表)", () => {
    for (const level of policy.APP_ACCESS_LEVELS) {
      expect(policy.APP_ACCESS_LEVEL_LABELS[level].length).toBeGreaterThan(0);
      expect(policy.APP_ACCESS_LEVEL_DESCRIPTIONS[level].length).toBeGreaterThan(0);
    }
  });
});

describe("level ⇄ permission keys", () => {
  it("edit materialises BOTH keys, view just the view key, none nothing", () => {
    expect(policy.keysForAppLevel("tasks", "edit")).toEqual(["app:tasks:view", "app:tasks:edit"]);
    expect(policy.keysForAppLevel("tasks", "view")).toEqual(["app:tasks:view"]);
    expect(policy.keysForAppLevel("tasks", "none")).toEqual([]);
    expect(policy.keysForAppLevel("not-an-app", "edit")).toEqual([]);
  });

  it("derives the level back from a key set (edit wins even without the view key)", () => {
    expect(policy.appAccessLevelOf([], "chat")).toBe("none");
    expect(policy.appAccessLevelOf(["app:chat:view"], "chat")).toBe("view");
    expect(policy.appAccessLevelOf(["app:chat:view", "app:chat:edit"], "chat")).toBe("edit");
    expect(policy.appAccessLevelOf(["app:chat:edit"], "chat")).toBe("edit");
    expect(policy.appAccessLevelOf(["app:chat:edit"], "not-an-app")).toBe("none");
  });

  it("setAppAccessLevel touches ONLY that app's pair (詳細設定 survive a level change)", () => {
    const before: Key[] = ["app:chat:view", "chat:create", "chat:moderate", "app:mail:edit", "app:mail:view"];
    const after = policy.setAppAccessLevel(before, "chat", "edit");
    expect(after).toContain("app:chat:edit");
    // fine-grained chat keys and the unrelated mail app are untouched
    expect(after).toContain("chat:create");
    expect(after).toContain("chat:moderate");
    expect(after).toContain("app:mail:edit");
    // turning it off removes both graded keys and nothing else
    const off = policy.setAppAccessLevel(after, "chat", "none");
    expect(off).not.toContain("app:chat:view");
    expect(off).not.toContain("app:chat:edit");
    expect(off).toContain("chat:create");
  });

  it("returns a sorted set and never mutates the input", () => {
    const input: Key[] = ["app:mail:view"];
    const out = policy.setAppAccessLevel(input, "events", "edit");
    expect(input).toEqual(["app:mail:view"]);
    expect(out).toEqual([...out].sort());
  });

  it("normalizeAppAccessKeys repairs edit-without-view by ADDING view (never downgrading)", () => {
    const fixed = policy.normalizeAppAccessKeys(["app:gantt:edit", "task:write"]);
    expect(fixed).toContain("app:gantt:view");
    expect(fixed).toContain("app:gantt:edit");
    expect(fixed).toContain("task:write");
    // idempotent
    expect(policy.normalizeAppAccessKeys(fixed)).toEqual(fixed);
  });
});

describe("coverage — a new app is included automatically", () => {
  it("appAccessMap has an entry for EVERY registered app, no gaps", () => {
    const map = policy.appAccessMap(["app:events:view"]);
    expect(Object.keys(map).sort()).toEqual([...appRegistry.APP_IDS].sort());
    expect(map.events).toBe("view");
    for (const id of appRegistry.APP_IDS) expect(policy.isAppAccessLevel(map[id])).toBe(true);
  });

  it("appCapabilities has flags for EVERY app, defaulting to fail-closed", () => {
    const caps = policy.appCapabilities([]);
    expect(Object.keys(caps).sort()).toEqual([...appRegistry.APP_IDS].sort());
    for (const id of appRegistry.APP_IDS) {
      expect(caps[id]).toMatchObject({ level: "none", enabled: false, canView: false, canEdit: false, readOnly: false });
    }
  });

  it("appPolicyRows renders one row per app in launcher order", () => {
    const rows = policy.appPolicyRows([]);
    expect(rows.map((r) => r.id)).toEqual([...appRegistry.APP_IDS]);
    for (const row of rows) expect(row.label.length).toBeGreaterThan(0);
  });
});

describe("capability flags — 閲覧 means buttons are dead", () => {
  it("view ⇒ readOnly (canView, NOT canEdit)", () => {
    const cap = policy.appCapability(["app:tasks:view"], "tasks");
    expect(cap).toMatchObject({ level: "view", enabled: true, canView: true, canEdit: false, readOnly: true });
  });

  it("edit ⇒ canEdit and NOT readOnly", () => {
    const cap = policy.appCapability(["app:tasks:view", "app:tasks:edit"], "tasks");
    expect(cap).toMatchObject({ level: "edit", enabled: true, canView: true, canEdit: true, readOnly: false });
  });

  it("none ⇒ nothing, and an unregistered app id fails closed", () => {
    expect(policy.appCapability([], "tasks")).toMatchObject({ enabled: false, canView: false, canEdit: false });
    expect(policy.appCapability(["app:tasks:edit"], "ghost-app")).toMatchObject({
      canView: false,
      canEdit: false,
      readOnly: false,
    });
  });

  it("carries the app's Japanese label for UI copy", () => {
    expect(policy.appCapability([], "gantt").label).toBe("ガントチャート");
  });
});

describe("decide() — default deny with a usable reason", () => {
  const viewer: Key[] = ["app:chat:view", "chat:create"];

  it("allows a read when the role holds 閲覧", () => {
    const d = policy.decide(viewer, { app: "chat", level: "view" });
    expect(d.allowed).toBe(true);
    expect(d.missing).toEqual([]);
    expect(d.level).toBe("view");
  });

  it("denies a write with reason read_only when the role holds only 閲覧", () => {
    const d = policy.decide(viewer, { app: "chat", level: "edit" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("read_only");
    expect(d.missing).toEqual(["app:chat:edit"]);
    expect(policy.denyMessage(d, "チャット")).toContain("閲覧のみ");
  });

  it("denies with reason app_disabled when the app is 無効", () => {
    const d = policy.decide([], { app: "chat", level: "view" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("app_disabled");
    expect(policy.denyMessage(d, "チャット")).toContain("無効");
  });

  it("AND-checks an extra fine-grained key on top of the level", () => {
    const granted: Key[] = ["app:chat:view", "app:chat:edit"];
    const d = policy.decide(granted, { app: "chat", level: "edit", permission: "chat:moderate" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("missing_permission");
    expect(d.missing).toEqual(["chat:moderate"]);
    expect(policy.decide([...granted, "chat:moderate"], { app: "chat", level: "edit", permission: "chat:moderate" }).allowed).toBe(true);
  });

  it("a legacy edit-only key set still satisfies a 閲覧 requirement (level owns the graded keys)", () => {
    // appAccessLevelOf treats a lone `:edit` as 編集; the level gate must therefore allow a
    // view request even though the `app:x:view` key itself is absent from the row.
    const d = policy.decide(["app:chat:edit"], { app: "chat", level: "view" });
    expect(d.allowed).toBe(true);
    expect(d.level).toBe("edit");
  });

  it("fails closed for an unregistered app", () => {
    const d = policy.decide(["app:chat:edit"], { app: "ghost-app", level: "view" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unknown_app");
  });

  it("requiredKeysFor is exactly what an enforcement point must check (no dupes)", () => {
    expect(policy.requiredKeysFor({ app: "mail", level: "edit" })).toEqual(["app:mail:view", "app:mail:edit"]);
    expect(policy.requiredKeysFor({ app: "mail", level: "edit", permission: "mail:send" })).toEqual([
      "app:mail:view",
      "app:mail:edit",
      "mail:send",
    ]);
    // a permission that IS the graded key is not duplicated
    expect(policy.requiredKeysFor({ app: "mail", level: "view", permission: "app:mail:view" })).toEqual(["app:mail:view"]);
  });
});

describe("catalog partition — 詳細設定 vs その他", () => {
  it("an app's 詳細 keys resolve to real catalog entries", () => {
    const entries = policy.appDetailPermissions("mail");
    expect(entries.map((e) => e.key)).toEqual(["mail:read", "mail:send", "mail:read_all", "mail:read_role_shared", "mail:admin"]);
    for (const e of entries) expect(e.name.length).toBeGreaterThan(0);
  });

  it("an app with no fine-grained knob returns [] (not a crash)", () => {
    expect(policy.appDetailPermissions("gantt")).toEqual([]);
    expect(policy.appDetailPermissions("not-an-app")).toEqual([]);
  });

  it("その他 = インフラ/監査/GitHub/Webhook だけ (アプリが引き取った鍵は残らない)", () => {
    const keys = policy.otherPermissions().map((e) => e.key);
    // org-wide keys that intentionally belong to no app
    expect(keys).toContain("infra:deploy");
    expect(keys).toContain("audit:read");
    expect(keys).toContain("github:admin");
    expect(keys).toContain("webhook:read");
    // claimed-by-an-app keys are NOT in その他 — 名簿/ロールは運営メンバー、ファイルは Drive共有
    expect(keys).not.toContain("mail:send");
    expect(keys).not.toContain("identity:read");
    expect(keys).not.toContain("identity:admin");
    expect(keys).not.toContain("file:read");
    expect(keys).not.toContain("file:write");
    expect(keys).not.toContain("file:admin");
    expect(keys).not.toContain("drive:read");
    expect(keys).not.toContain("chat:moderate");
    // graded per-app keys are rendered by the 3 段階 selector, never as その他 checkboxes
    for (const k of keys) expect(k.startsWith("app:")).toBe(false);
  });

  it("その他 is grouped by domain for rendering", () => {
    const groups = policy.otherPermissionGroups();
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.flatMap((g) => g.entries).length).toBe(policy.otherPermissions().length);
    for (const g of groups) expect(g.entries.every((e) => e.domain === g.domain)).toBe(true);
    // 残るドメインはこの4つだけ (出現順に依存しないよう集合で比較)
    expect(new Set(groups.map((g) => g.domain))).toEqual(new Set(["infra", "audit", "github", "webhook"]));
  });

  it("名簿・ロールは運営メンバー、ファイル/Drive は Drive共有 の詳細設定が持つ", () => {
    expect(policy.appDetailPermissions("members").map((e) => e.key)).toEqual(
      expect.arrayContaining(["identity:read", "identity:admin"]),
    );
    expect(policy.appDetailPermissions("driveshare").map((e) => e.key)).toEqual(
      expect.arrayContaining(["drive:read", "drive:write", "file:read", "file:write", "file:admin"]),
    );
    // ロール管理 itself is 無効/閲覧/編集 の3段階だけ (identity:admin は運営メンバー側)
    expect(policy.appDetailPermissions("admin")).toEqual([]);
  });

  it("appPolicySummary counts enabled apps", () => {
    expect(policy.appPolicySummary([])).toEqual({ enabled: 0, total: appRegistry.APP_IDS.length });
    expect(policy.appPolicySummary(["app:chat:view", "app:mail:edit"]).enabled).toBe(2);
  });

  it("detail badge counts how many of an app's 詳細 keys the role holds", () => {
    const row = policy.appPolicyRows(["app:mail:view", "mail:read", "mail:send"]).find((r) => r.id === "mail")!;
    expect(row.detail).toEqual({ granted: 2, total: 5 });
    expect(row.level).toBe("view");
  });
});
