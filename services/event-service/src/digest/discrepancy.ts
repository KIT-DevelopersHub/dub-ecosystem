// 食い違い: a source states a value that disagrees with the event's own field. The AI
// never "fixes" the event — the discrepancy is shown at the top of the digest and a
// human decides. Deterministic (no LLM): compares normalized values only.
import type { event } from "@dub/types";
import type { DigestEventFacts, SourceSnapshot } from "./types";

function normVenue(v: string): string {
  return v.replace(/[\s　・,、()（）]/g, "").toLowerCase();
}

export function findDiscrepancies(ev: DigestEventFacts, snaps: SourceSnapshot[]): event.EventDigestDiscrepancy[] {
  const out: event.EventDigestDiscrepancy[] = [];
  const evDay = ev.startsAt ? ev.startsAt.slice(0, 10) : null;
  for (const s of snaps) {
    const f = s.facts;
    if (!f) continue;
    const link = s.factsLink ?? "";
    if (!link) continue;
    if (f.startsAt && evDay && f.startsAt !== evDay) {
      out.push({ field: "startsAt", eventValue: evDay, sourceValue: f.startsAt, source: s.source, link });
    }
    if (f.venue && ev.venue && !normVenue(ev.venue).includes(normVenue(f.venue)) && !normVenue(f.venue).includes(normVenue(ev.venue))) {
      out.push({ field: "venue", eventValue: ev.venue, sourceValue: f.venue, source: s.source, link });
    }
    if (typeof f.capacity === "number" && typeof ev.capacity === "number" && f.capacity !== ev.capacity) {
      out.push({ field: "capacity", eventValue: String(ev.capacity), sourceValue: String(f.capacity), source: s.source, link });
    }
  }
  return out;
}
