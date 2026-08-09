// In-memory adapters (unit tests + local dev without D1). Cursor = offset index.
import type { GithubRepoConfig, LinkRecord, SyncRunRecord } from "../domain/types";
import type {
  LinkFilter,
  LinkStore,
  Page,
  ProcessedEventStore,
  RepoFilter,
  RepoStore,
  RunStore,
  Stores,
} from "./types";

function paginate<T>(rows: T[], cursor: string | null, limit: number): Page<T> {
  const start = cursor ? Number(cursor) || 0 : 0;
  const slice = rows.slice(start, start + limit);
  const next = start + limit < rows.length ? String(start + limit) : null;
  return { items: slice, nextCursor: next };
}

export class MemoryRepoStore implements RepoStore {
  private readonly map = new Map<string, GithubRepoConfig>();
  async create(repo: GithubRepoConfig): Promise<void> {
    this.map.set(repo.id, { ...repo });
  }
  async get(id: string): Promise<GithubRepoConfig | null> {
    const r = this.map.get(id);
    return r ? { ...r } : null;
  }
  async getByOwnerRepo(owner: string, repo: string): Promise<GithubRepoConfig | null> {
    for (const r of this.map.values()) if (r.owner === owner && r.repo === repo) return { ...r };
    return null;
  }
  async list(filter: RepoFilter, cursor: string | null, limit: number): Promise<Page<GithubRepoConfig>> {
    let rows = [...this.map.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (filter.eventId !== undefined) rows = rows.filter((r) => r.eventId === filter.eventId);
    if (filter.enabled !== undefined) rows = rows.filter((r) => r.enabled === filter.enabled);
    return paginate(rows, cursor, limit);
  }
  async update(id: string, patch: Partial<GithubRepoConfig>): Promise<GithubRepoConfig | null> {
    const cur = this.map.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id };
    this.map.set(id, next);
    return { ...next };
  }
  async delete(id: string): Promise<boolean> {
    return this.map.delete(id);
  }
}

export class MemoryLinkStore implements LinkStore {
  private readonly map = new Map<string, LinkRecord>();
  async create(link: LinkRecord): Promise<void> {
    this.map.set(link.id, { ...link });
  }
  async getById(id: string): Promise<LinkRecord | null> {
    const r = this.map.get(id);
    return r ? { ...r } : null;
  }
  async getByTaskId(taskId: string): Promise<LinkRecord | null> {
    for (const r of this.map.values()) if (r.taskId === taskId) return { ...r };
    return null;
  }
  async getByIssue(repoId: string, issueNumber: number): Promise<LinkRecord | null> {
    for (const r of this.map.values()) if (r.repoId === repoId && r.issueNumber === issueNumber) return { ...r };
    return null;
  }
  async list(filter: LinkFilter, cursor: string | null, limit: number): Promise<Page<LinkRecord>> {
    let rows = [...this.map.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (filter.taskId !== undefined) rows = rows.filter((r) => r.taskId === filter.taskId);
    if (filter.owner !== undefined) rows = rows.filter((r) => r.owner === filter.owner);
    if (filter.repo !== undefined) rows = rows.filter((r) => r.repo === filter.repo);
    if (filter.repoId !== undefined) rows = rows.filter((r) => r.repoId === filter.repoId);
    if (filter.issueNumber !== undefined) rows = rows.filter((r) => r.issueNumber === filter.issueNumber);
    if (filter.syncState && filter.syncState.length > 0)
      rows = rows.filter((r) => filter.syncState!.includes(r.syncState));
    return paginate(rows, cursor, limit);
  }
  async update(id: string, patch: Partial<LinkRecord>): Promise<LinkRecord | null> {
    const cur = this.map.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id };
    this.map.set(id, next);
    return { ...next };
  }
  async delete(id: string): Promise<boolean> {
    return this.map.delete(id);
  }
}

export class MemoryRunStore implements RunStore {
  private readonly map = new Map<string, SyncRunRecord>();
  async create(run: SyncRunRecord): Promise<void> {
    this.map.set(run.id, { ...run });
  }
  async get(id: string): Promise<SyncRunRecord | null> {
    const r = this.map.get(id);
    return r ? { ...r } : null;
  }
  async list(cursor: string | null, limit: number): Promise<Page<SyncRunRecord>> {
    const rows = [...this.map.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return paginate(rows, cursor, limit);
  }
  async update(
    id: string,
    patch: Partial<Pick<SyncRunRecord, "status" | "stats" | "startedAt" | "finishedAt" | "error">>,
  ): Promise<void> {
    const cur = this.map.get(id);
    if (!cur) return;
    this.map.set(id, { ...cur, ...patch });
  }
  async hasActive(scopeKey: string): Promise<boolean> {
    for (const r of this.map.values()) {
      if ((r.status === "queued" || r.status === "running") && this.scopeKeyOf(r) === scopeKey) return true;
    }
    return false;
  }
  private scopeKeyOf(r: SyncRunRecord): string {
    return `${r.scope}:${r.repoId ?? "*"}`;
  }
}

export class MemoryProcessedEventStore implements ProcessedEventStore {
  private readonly map = new Map<string, string>();
  async wasProcessed(eventId: string): Promise<boolean> {
    return this.map.has(eventId);
  }
  async markProcessed(eventId: string): Promise<void> {
    this.map.set(eventId, new Date().toISOString());
  }
  async purgeOlderThan(iso: string): Promise<number> {
    let n = 0;
    for (const [k, v] of this.map) if (v < iso) (this.map.delete(k), n++);
    return n;
  }
}

export function memoryStores(): Stores {
  return {
    repos: new MemoryRepoStore(),
    links: new MemoryLinkStore(),
    runs: new MemoryRunStore(),
    processed: new MemoryProcessedEventStore(),
  };
}
