// In-memory EventRepo: backs unit tests and local `--test` runs. Same keyset
// semantics as the D1 repo so pagination tests are representative.
import type { common, event } from "@dub/types";
import type { EventRepo, EventRow, ActionRow, EventDetailsRow, Keyset } from "./types";

function afterKeysetById(id: string) {
  return (row: { id: string }) => row.id > id;
}

export class InMemoryEventRepo implements EventRepo {
  private events = new Map<common.EventId, EventRow>();
  private actions = new Map<common.ActionId, ActionRow>();
  private details = new Map<common.EventId, EventDetailsRow>();

  // test/seed helper — bypasses service invariants (e.g. cross-org rows).
  seedEvent(row: EventRow): void {
    this.events.set(row.id, { ...row });
  }
  seedAction(row: ActionRow): void {
    this.actions.set(row.id, { ...row });
  }

  async createEvent(row: EventRow): Promise<void> {
    this.events.set(row.id, { ...row });
  }
  async getEvent(id: common.EventId): Promise<EventRow | null> {
    const r = this.events.get(id);
    return r ? { ...r } : null;
  }
  async updateEvent(next: EventRow, expectedVersion: number): Promise<boolean> {
    const cur = this.events.get(next.id);
    if (!cur || cur.version !== expectedVersion) return false;
    this.events.set(next.id, { ...next });
    return true;
  }
  async listEvents(q: {
    orgId: common.OrgId;
    phase?: event.EventPhase;
    startsAfter?: string;
    sort?: "startsAt";
    includeArchived: boolean;
    limit: number;
    after?: Keyset;
  }): Promise<EventRow[]> {
    let rows = [...this.events.values()].filter((r) => r.orgId === q.orgId);
    if (!q.includeArchived) rows = rows.filter((r) => r.archivedAt === null);
    if (q.phase) rows = rows.filter((r) => r.phase === q.phase);
    if (q.startsAfter) rows = rows.filter((r) => r.startsAt !== null && r.startsAt >= q.startsAfter!);

    if (q.sort === "startsAt") {
      rows.sort((a, b) => cmpNullableAsc(a.startsAt, b.startsAt) || cmpStr(a.id, b.id));
      if (q.after) {
        const a = q.after;
        rows = rows.filter((r) => {
          const c = cmpNullableAsc(r.startsAt, a.s ?? null);
          return c > 0 || (c === 0 && r.id > a.id);
        });
      }
    } else {
      rows.sort((a, b) => cmpStr(a.id, b.id));
      if (q.after) rows = rows.filter(afterKeysetById(q.after.id));
    }
    return rows.slice(0, q.limit).map((r) => ({ ...r }));
  }

  async createAction(row: ActionRow): Promise<void> {
    this.actions.set(row.id, { ...row });
  }
  async getAction(id: common.ActionId): Promise<ActionRow | null> {
    const r = this.actions.get(id);
    return r ? { ...r } : null;
  }
  async updateAction(next: ActionRow, expectedVersion: number): Promise<boolean> {
    const cur = this.actions.get(next.id);
    if (!cur || cur.version !== expectedVersion) return false;
    this.actions.set(next.id, { ...next });
    return true;
  }
  async listActions(q: {
    eventId: common.EventId;
    kind?: string;
    includeArchived: boolean;
    limit: number;
    after?: Keyset;
  }): Promise<ActionRow[]> {
    let rows = [...this.actions.values()].filter((r) => r.eventId === q.eventId);
    if (!q.includeArchived) rows = rows.filter((r) => r.archivedAt === null);
    if (q.kind) rows = rows.filter((r) => r.kind === q.kind);
    rows.sort((a, b) => a.sortOrder - b.sortOrder || cmpStr(a.id, b.id));
    if (q.after) {
      const a = q.after;
      const n = a.n ?? 0;
      rows = rows.filter((r) => r.sortOrder > n || (r.sortOrder === n && r.id > a.id));
    }
    return rows.slice(0, q.limit).map((r) => ({ ...r }));
  }
  async actionsForEvent(eventId: common.EventId, cap: number): Promise<ActionRow[]> {
    return [...this.actions.values()]
      .filter((r) => r.eventId === eventId && r.archivedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder || cmpStr(a.id, b.id))
      .slice(0, cap)
      .map((r) => ({ ...r }));
  }
  async maxSortOrder(eventId: common.EventId): Promise<number> {
    let max = 0;
    for (const r of this.actions.values()) {
      if (r.eventId === eventId && r.sortOrder > max) max = r.sortOrder;
    }
    return max;
  }

  async getEventDetails(eventId: common.EventId): Promise<EventDetailsRow | null> {
    const r = this.details.get(eventId);
    return r ? cloneDetails(r) : null;
  }
  async upsertEventDetails(next: EventDetailsRow, expectedVersion: number): Promise<boolean> {
    const cur = this.details.get(next.eventId);
    const curVersion = cur?.version ?? 0;
    if (curVersion !== expectedVersion) return false;
    this.details.set(next.eventId, cloneDetails(next));
    return true;
  }
}

function cloneDetails(r: EventDetailsRow): EventDetailsRow {
  return {
    ...r,
    data: {
      ...r.data,
      links: r.data.links.map((l) => ({ ...l })),
      contacts: r.data.contacts.map((c) => ({ ...c })),
    },
  };
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
// null sorts last (ascending).
function cmpNullableAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
