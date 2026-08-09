import { describe, it, expect } from "vitest";
import { organizationJsonLd, eventJsonLd, serializeJsonLd } from "../src/lib/jsonld";

describe("organizationJsonLd", () => {
  it("emits a valid Organization node", () => {
    const node = organizationJsonLd({ name: "DevelopersHub", url: "https://developershub.jp", sameAs: ["https://github.com/x"] });
    expect(node["@type"]).toBe("Organization");
    expect(node["@context"]).toBe("https://schema.org");
    expect(node.sameAs).toEqual(["https://github.com/x"]);
  });

  it("omits empty optionals", () => {
    const node = organizationJsonLd({ name: "X", url: "https://x.jp", sameAs: [] });
    expect(node.sameAs).toBeUndefined();
    expect(node.logo).toBeUndefined();
  });
});

describe("eventJsonLd", () => {
  it("emits an Event node with place + dates", () => {
    const node = eventJsonLd({
      name: "北陸ITカンファレンス 2026",
      url: "https://developershub.jp/events/hokuriku-it-2026",
      startDate: "2026-08-05T10:00:00+09:00",
      endDate: "2026-08-05T18:00:00+09:00",
      locationName: "金沢",
      status: "open",
    });
    expect(node["@type"]).toBe("Event");
    expect(node.startDate).toContain("2026-08-05");
    expect(node.endDate).toContain("2026-08-05");
    expect((node.location as Record<string, unknown>)["@type"]).toBe("Place");
    expect(node.eventStatus).toContain("schema.org");
  });

  it("defaults status and omits absent location", () => {
    const node = eventJsonLd({ name: "X", url: "https://x.jp/e/x", startDate: "2026-01-01" });
    expect(node.location).toBeUndefined();
    expect(node.eventStatus).toBeTruthy();
  });
});

describe("serializeJsonLd", () => {
  it("escapes </script> to prevent tag breakout (matches JSON.stringify snapshot otherwise)", () => {
    const s = serializeJsonLd({ x: "</script><b>" });
    expect(s).not.toContain("</script>");
    expect(s).toContain("\\u003c");
  });

  it("round-trips to the same object after unescaping", () => {
    const node = eventJsonLd({ name: "T", url: "https://x.jp/e/t", startDate: "2026-01-01" });
    const parsed = JSON.parse(serializeJsonLd(node));
    expect(parsed).toEqual(node);
  });
});
