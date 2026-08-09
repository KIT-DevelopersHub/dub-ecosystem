import { describe, it, expect } from "vitest";
import { eventSchema, newsSchema, sponsorPlanSchema } from "../src/content/schemas";

describe("eventSchema", () => {
  const valid = {
    title: "北陸ITカンファレンス 2026",
    status: "open",
    dateStart: "2026-08-05",
    venue: { name: "金沢商工会議所" },
    summary: "北陸最大級の開発者カンファレンス。",
  };

  it("accepts a minimal valid event", () => {
    expect(eventSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a fully-populated event (timetable/speakers/sponsorTiers)", () => {
    const full = {
      ...valid,
      dateEnd: "2026-08-05",
      timetable: [{ time: "10:00", title: "Keynote", speaker: "X", track: "A" }],
      speakers: [{ name: "X", org: "DevelopersHub" }],
      sponsorTiers: [{ tier: "platinum", sponsors: [{ name: "Acme", logoUrl: "/l.png", url: "https://acme.com" }] }],
      registrationUrl: "https://example.com/register",
    };
    expect(eventSchema.safeParse(full).success).toBe(true);
  });

  it("rejects an unknown status (FE8 display vocabulary is closed)", () => {
    expect(eventSchema.safeParse({ ...valid, status: "cancelled" }).success).toBe(false);
  });

  it("rejects missing required fields (venue.name)", () => {
    expect(eventSchema.safeParse({ ...valid, venue: {} }).success).toBe(false);
  });

  it("rejects a non-URL registrationUrl", () => {
    expect(eventSchema.safeParse({ ...valid, registrationUrl: "not-a-url" }).success).toBe(false);
  });
});

describe("newsSchema", () => {
  it("requires title and publishedAt", () => {
    expect(newsSchema.safeParse({ title: "お知らせ", publishedAt: "2026-08-01" }).success).toBe(true);
    expect(newsSchema.safeParse({ title: "", publishedAt: "2026-08-01" }).success).toBe(false);
    expect(newsSchema.safeParse({ title: "x" }).success).toBe(false);
  });
});

describe("sponsorPlanSchema", () => {
  it("accepts a valid tier plan and defaults order", () => {
    const parsed = sponsorPlanSchema.parse({
      tier: "gold",
      label: "ゴールド",
      priceJpy: 300000,
      benefits: ["ロゴ掲載", "登壇枠"],
    });
    expect(parsed.order).toBe(0);
  });

  it("allows null price (custom) and rejects empty benefits", () => {
    expect(sponsorPlanSchema.safeParse({ tier: "custom", label: "個別", priceJpy: null, benefits: ["相談"] }).success).toBe(true);
    expect(sponsorPlanSchema.safeParse({ tier: "gold", label: "G", priceJpy: 1, benefits: [] }).success).toBe(false);
  });

  it("rejects an unknown tier", () => {
    expect(sponsorPlanSchema.safeParse({ tier: "diamond", label: "D", priceJpy: 1, benefits: ["x"] }).success).toBe(false);
  });
});
