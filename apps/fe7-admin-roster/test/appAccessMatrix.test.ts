import { describe, it, expect } from "vitest";
import { identity, appRegistry } from "@dub/types";
import {
  appAccessRows,
  appAccessLevel,
  appAccessSummary,
  availableLevels,
  allRowKeys,
  setAppAccessLevel,
  toggleAppEnabled,
  classifyCapabilityAction,
  type AppAccessRow,
} from "../src/lib/appAccessMatrix";

const catalog = identity.PERMISSION_CATALOG;
const rowFor = (id: string): AppAccessRow => appAccessRows(catalog).find((r) => r.id === id)!;

describe("appAccessMatrix — per-app access + capability folding", () => {
  it("exposes one row per manifest app, in launcher order, with its view/edit keys", () => {
    const rows = appAccessRows(catalog);
    expect(rows.map((r) => r.id)).toEqual(appRegistry.APP_IDS);
    const gantt = rowFor("gantt");
    expect(gantt.view).toBe("app:gantt:view");
    expect(gantt.edit).toBe("app:gantt:edit");
    expect(rowFor("usage").openToAll).toBe(true);
    expect(rowFor("events").openToAll).toBe(false);
  });

  it("classifies capability actions by verb (view/edit/manage), unknown verbs fall back to edit", () => {
    expect(classifyCapabilityAction("mail:read")).toBe("view");
    expect(classifyCapabilityAction("mail:send")).toBe("edit");
    expect(classifyCapabilityAction("mail:admin")).toBe("manage");
    expect(classifyCapabilityAction("mail:read_all")).toBe("manage");
    expect(classifyCapabilityAction("foo:some_future_verb")).toBe("edit");
  });

  describe("a domain owned by exactly ONE app (mail) folds its capability keys in", () => {
    it("buckets mail's capability keys into view/edit/manage on the mail row", () => {
      const mail = rowFor("mail");
      expect(mail.sharedDomain).toBe(false);
      expect(mail.viewKeys.map((k) => k.key)).toEqual(["mail:read"]);
      expect(mail.editKeys.map((k) => k.key)).toEqual(["mail:send"]);
      expect(mail.manageKeys.map((k) => k.key).sort()).toEqual(["mail:admin", "mail:read_all"]);
      expect(availableLevels(mail)).toEqual(["off", "view", "edit", "manage"]);
    });

    it("reads off/view/edit/manage from the selected set (highest tier with any key on)", () => {
      const mail = rowFor("mail");
      expect(appAccessLevel([], mail)).toBe("off");
      expect(appAccessLevel(["app:mail:view", "mail:read"], mail)).toBe("view");
      expect(appAccessLevel(["app:mail:view", "app:mail:edit", "mail:read", "mail:send"], mail)).toBe("edit");
      expect(appAccessLevel(["mail:admin"], mail)).toBe("manage");
    });

    it("setAppAccessLevel(manage) turns on view+edit+manage keys and off nothing above", () => {
      const mail = rowFor("mail");
      const next = setAppAccessLevel([], mail, "manage");
      expect(next).toEqual(
        ["app:mail:edit", "app:mail:view", "mail:admin", "mail:read", "mail:read_all", "mail:send"].sort(),
      );
    });

    it("downgrading from manage to view turns off edit/manage keys but keeps view keys", () => {
      const mail = rowFor("mail");
      const full = setAppAccessLevel([], mail, "manage");
      expect(setAppAccessLevel(full, mail, "view")).toEqual(["app:mail:view", "mail:read"].sort());
    });

    it("off clears every key this row owns, including capability keys", () => {
      const mail = rowFor("mail");
      const full = setAppAccessLevel([], mail, "manage");
      expect(setAppAccessLevel(full, mail, "off")).toEqual([]);
    });

    it("does not disturb another app's keys", () => {
      const mail = rowFor("mail");
      expect(setAppAccessLevel(["app:events:view"], mail, "view").sort()).toEqual(
        ["app:events:view", "app:mail:view", "mail:read"].sort(),
      );
    });
  });

  describe("a domain shared by >1 app (task: tasks+gantt, identity: members/participation/admin) stays access-only", () => {
    it("has no capability keys folded in and no manage tier", () => {
      const gantt = rowFor("gantt");
      const tasks = rowFor("tasks");
      expect(gantt.sharedDomain).toBe(true);
      expect(tasks.sharedDomain).toBe(true);
      expect(gantt.viewKeys).toEqual([]);
      expect(gantt.editKeys).toEqual([]);
      expect(gantt.manageKeys).toEqual([]);
      expect(availableLevels(gantt)).toEqual(["off", "view", "edit"]);
    });

    it("gantt and tasks toggle INDEPENDENTLY (the guarantee this preserves)", () => {
      const withGantt = setAppAccessLevel([], rowFor("gantt"), "view");
      expect(appAccessLevel(withGantt, rowFor("tasks"))).toBe("off");
      const withParticipation = setAppAccessLevel([], rowFor("participation"), "view");
      expect(appAccessLevel(withParticipation, rowFor("members"))).toBe("off");
    });

    it("toggleAppEnabled flips off<->view without touching edit level semantics", () => {
      const p = rowFor("participation");
      expect(toggleAppEnabled([], p, true)).toEqual(["app:participation:view"]);
      expect(toggleAppEnabled(["app:participation:view", "app:participation:edit"], p, false)).toEqual([]);
    });
  });

  it("a locked key is never turned off by a downgrade, even below its own tier", () => {
    const mail = rowFor("mail");
    const full = setAppAccessLevel([], mail, "manage");
    // pretend mail:admin is a locked (self-lockout) key on this role
    const downgraded = setAppAccessLevel(full, mail, "off", ["mail:admin"]);
    expect(downgraded).toContain("mail:admin");
    expect(downgraded).not.toContain("mail:send");
  });

  it("allRowKeys lists every key a row can ever touch", () => {
    const mail = rowFor("mail");
    expect(allRowKeys(mail).sort()).toEqual(
      ["app:mail:edit", "app:mail:view", "mail:admin", "mail:read", "mail:read_all", "mail:send"].sort(),
    );
  });

  it("summary counts enabled apps out of total", () => {
    const rows = appAccessRows(catalog);
    expect(appAccessSummary([], rows)).toEqual({ enabled: 0, total: appRegistry.APP_IDS.length });
    expect(appAccessSummary(["app:mail:view", "app:gantt:edit"], rows).enabled).toBe(2);
  });
});
