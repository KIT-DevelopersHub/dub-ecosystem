import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDbClient } from "@dub/db";
import { gcpCollector, readGoogleApiPeaks } from "../src/collectors/gcp";
import { makeD1 } from "./d1";

const NOW = new Date("2026-11-07T12:00:30.000Z");
const DDL = readFileSync(fileURLToPath(new URL("../../../infra/d1/migrations/driveshare/0005_google_api_usage.sql", import.meta.url)), "utf8");

function seeded(rows: [string, string, number][]) {
  const { d1, raw } = makeD1();
  raw.exec(DDL);
  for (const [api, minute, calls] of rows) raw.prepare("INSERT INTO driveshare_google_api_usage VALUES (?, ?, ?)").run(api, minute, calls);
  return d1;
}

describe("gcp collector", () => {
  it("takes the busiest minute of the last 24h per API", async () => {
    const d1 = seeded([
      ["calendar", "2026-11-07T11:00", 5],
      ["calendar", "2026-11-07T02:00", 40],
      ["calendar", "2026-11-06T11:59", 500], // older than 24h
      ["meet", "2026-11-06T12:00", 7], // the window's first minute
    ]);
    const out = await readGoogleApiPeaks(createDbClient(d1, { namespace: "driveshare" }), NOW);
    expect(out).toEqual({ gcp_calendar_requests_peak_minute: 40, gcp_meet_requests_peak_minute: 7 });
  });

  it("reads no calls as 0, not unknown", async () => {
    const out = await readGoogleApiPeaks(createDbClient(seeded([]), { namespace: "driveshare" }), NOW);
    expect(out).toEqual({ gcp_calendar_requests_peak_minute: 0, gcp_meet_requests_peak_minute: 0 });
  });

  it("omits the metrics when the table cannot be read", async () => {
    const { d1 } = makeD1(); // migration not applied
    await expect(gcpCollector.collect({ DB: d1 }, createDbClient(d1, { namespace: "mail" }), NOW)).resolves.toEqual({});
  });
});
