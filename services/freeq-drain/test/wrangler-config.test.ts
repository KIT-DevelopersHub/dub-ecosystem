// Regression guard on wrangler.toml: the DO-alarm switch (no cron, FreeqDrainDO bound with a
// free-tier SQLite migration) and the binding fixes (phantom DBs -> real dub-core id,
// SVC_MOBILE_BFF -> the live worker name). Config-only, so a text assertion is enough and
// keeps CI from needing a TOML parser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
const DUB_CORE_ID = "d663f9c6-499f-4c67-910d-e08733d5278d";

describe("wrangler.toml — DO alarm replaces the cron", () => {
  it("has NO cron trigger (frees the full 5-cron account cap)", () => {
    expect(toml).not.toMatch(/crons\s*=/);
  });
  it("binds FreeqDrainDO with a free-tier SQLite migration", () => {
    expect(toml).toMatch(/class_name\s*=\s*"FreeqDrainDO"/);
    expect(toml).toMatch(/name\s*=\s*"DRAIN_DO"/);
    expect(toml).toMatch(/new_sqlite_classes\s*=\s*\[\s*"FreeqDrainDO"\s*\]/);
  });
});

describe("wrangler.toml — binding fixes", () => {
  it("no leftover placeholder ids", () => {
    expect(toml).not.toMatch(/REPLACE_AT_APPLY/);
  });
  it("DB_DRIVE / DB_MOBILE resolve to the real dub-core DB, not the phantom DBs", () => {
    expect(toml).not.toMatch(/database_name\s*=\s*"dub-drive-proxy-watch"/);
    expect(toml).not.toMatch(/database_name\s*=\s*"mobile"/);
    // DB_CORE + DB_DRIVE + DB_MOBILE all point at dub-core's id -> at least 3 occurrences.
    const occurrences = toml.match(new RegExp(DUB_CORE_ID, "g")) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });
  it("SVC_MOBILE_BFF binds the live worker name mo3-mobile-bff (no dub- prefix)", () => {
    expect(toml).toMatch(/service\s*=\s*"mo3-mobile-bff"/);
    expect(toml).not.toMatch(/dub-mo3-mobile-bff/);
  });
});
