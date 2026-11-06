import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createGoogleCallRecorder } from "../src/google/api-usage";
import { createGoogleCalendarClient } from "../src/google/calendar-client";
import { createGoogleMeetRecordsClient } from "../src/google/meet-records-client";

const token = { getAccessToken: async () => "t", grantedScopes: async () => null };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Google call counting", () => {
  it("attributes Calendar and Meet calls to their own API", async () => {
    const recordCall = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/spaces/") ? json({ name: "spaces/x", config: { accessType: "OPEN" } }) : json({ id: "c" }),
    ) as unknown as typeof fetch;
    const cal = createGoogleCalendarClient({ token: token as never, fetchImpl, recordCall });
    await cal.createCalendar("x", "Asia/Tokyo");
    await cal.openMeet("https://meet.google.com/abc-defg-hij");
    expect(recordCall.mock.calls).toEqual([["calendar"], ["meet"]]);

    recordCall.mockClear();
    await createGoogleMeetRecordsClient({ token: token as never, fetchImpl: (async () => json({})) as unknown as typeof fetch, recordCall }).listParticipants("conferenceRecords/1");
    expect(recordCall.mock.calls).toEqual([["meet"]]);
  });

  it("adds to the row of the current UTC minute", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: { sql: string; binds: unknown[] }[] = [];
    const d1 = {
      prepare: (sql: string) => ({ bind: (...binds: unknown[]) => ({ run: async () => (seen.push({ sql, binds }), { success: true, meta: {} }) }) }),
    } as unknown as D1Database;
    await createGoogleCallRecorder(d1, () => new Date("2026-11-07T12:34:56.000Z"))("meet");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.binds).toEqual(["meet", "2026-11-07T12:34"]);
    expect(warn).not.toHaveBeenCalled(); // the @dub/db namespace guard accepts the upsert
    warn.mockRestore();
  });

  it("a failed count does not fail the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d1 = { prepare: () => { throw new Error("d1 down"); } } as unknown as D1Database;
    await expect(createGoogleCallRecorder(d1)("calendar")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
