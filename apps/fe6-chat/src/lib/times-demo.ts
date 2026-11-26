// Demo / mock backend for times channels (#850): the same preview -> bulk contract as
// chat-service /chat/times/*, over whatever channel store the host keeps (fe6 MockChatClient,
// fe2 VITE_DEMO). Naming comes from @dub/types so the demo matches the server.
import { chat } from "@dub/types";

export interface TimesDemoMember {
  id: string;
  displayName: string;
  email: string;
}

export interface TimesSimDeps {
  /** Active members (the bulk target). */
  members: () => TimesDemoMember[];
  /** Non-DM channels currently in the store. `createdBy` unknown = someone else's. */
  channels: () => { id: string; name: string; createdBy?: string | null; archived?: boolean }[];
  /** Create a channel owned by `ownerId` (the owner is its only member); returns its id. */
  createChannel: (input: { ownerId: string; name: string; visibility: "public" | "private"; topic: string }) => string;
  config?: Partial<chat.TimesConfig>;
}

export const TIMES_DEMO_BATCH = 10;

export function createTimesSim(deps: TimesSimDeps) {
  const config: chat.TimesConfig = { prefix: chat.TIMES_DEFAULT_PREFIX, isPrivate: false, autoCreate: true, ...deps.config };
  const records = new Map<string, { channelId: string; channelName: string }>();

  const item = (m: TimesDemoMember, over: Partial<chat.TimesItem>): chat.TimesItem => ({
    userId: m.id,
    displayName: m.displayName,
    email: m.email,
    channelName: null,
    channelId: null,
    status: "planned",
    error: null,
    ...over,
  });

  function plan(m: TimesDemoMember, taken: Set<string>): { name: string; existingId: string | null } {
    const base = chat.timesBaseName(config.prefix, m);
    const chans = deps.channels();
    for (let i = 1; i <= chat.TIMES_MAX_SUFFIX; i++) {
      const name = chat.timesCandidate(base, i);
      if (taken.has(name)) continue;
      const same = chans.filter((c) => c.name === name);
      if (same.length === 0) return { name, existingId: null };
      const own = same.find((c) => !c.archived && c.createdBy === m.id);
      if (own) return { name, existingId: own.id };
    }
    return { name: `${base}-${Date.now().toString(36)}`, existingId: null };
  }

  const taken = () => new Set([...records.values()].map((r) => r.channelName));
  const pending = () => deps.members().filter((m) => !records.has(m.id));

  return {
    preview(): chat.TimesPreviewResponse {
      const t = taken();
      const items = pending().map((m) => {
        const p = plan(m, t);
        t.add(p.name);
        return item(m, { channelName: p.name, channelId: p.existingId, status: p.existingId ? "existing" : "planned" });
      });
      return { config, items, recordedCount: records.size };
    },
    bulk(userIds?: readonly string[]): chat.TimesBulkResponse {
      const wanted = userIds ? new Set(userIds) : null;
      const todo = pending().filter((m) => !wanted || wanted.has(m.id));
      const results = todo.slice(0, TIMES_DEMO_BATCH).map((m) => {
        const p = plan(m, taken());
        const channelId =
          p.existingId ??
          deps.createChannel({ ownerId: m.id, name: p.name, visibility: config.isPrivate ? "private" : "public", topic: `${m.displayName} の times` });
        records.set(m.id, { channelId, channelName: p.name });
        return item(m, { channelName: p.name, channelId, status: p.existingId ? "existing" : "created" });
      });
      return { results, remaining: Math.max(0, todo.length - TIMES_DEMO_BATCH) };
    },
  };
}

export type TimesSim = ReturnType<typeof createTimesSim>;
