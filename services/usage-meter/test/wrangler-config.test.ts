// Config guard on wrangler.toml / wrangler.free.toml: the DO-alarm switch (NO cron; MeterDO
// bound with a free-tier SQLite migration) and the shared dub-core binding. Config-only, so
// text assertions suffice (keeps CI free of a TOML parser).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const DUB_CORE_ID = "d663f9c6-499f-4c67-910d-e08733d5278d";
const base = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
const free = readFileSync(fileURLToPath(new URL("../wrangler.free.toml", import.meta.url)), "utf8");

for (const [name, toml] of [
  ["wrangler.toml", base],
  ["wrangler.free.toml", free],
] as const) {
  describe(`${name} — DO alarm, no cron`, () => {
    it("has NO cron trigger (does not touch the full 5-cron account cap)", () => {
      expect(toml).not.toMatch(/crons\s*=/);
    });
    it("binds MeterDO with a free-tier SQLite migration", () => {
      expect(toml).toMatch(/class_name\s*=\s*"MeterDO"/);
      expect(toml).toMatch(/name\s*=\s*"METER_DO"/);
      expect(toml).toMatch(/new_sqlite_classes\s*=\s*\[\s*"MeterDO"\s*\]/);
    });
    it("binds the shared dub-core D1 and has no placeholder id", () => {
      expect(toml).toContain(DUB_CORE_ID);
      expect(toml).not.toMatch(/REPLACE_AT/);
    });
    it("disables workers.dev (internal-only)", () => {
      expect(toml).toMatch(/workers_dev\s*=\s*false/);
    });
  });
}

describe("wrangler.free.toml — live worker name", () => {
  it("deploys as dub-usage-meter", () => {
    expect(free).toMatch(/name\s*=\s*"dub-usage-meter"/);
  });
});
