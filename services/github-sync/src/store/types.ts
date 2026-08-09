// Persistence ports. The engine/routes depend only on these interfaces so unit
// tests run against the in-memory adapter and production uses the D1 adapter.
import type {
  GithubRepoConfig,
  LinkRecord,
  SyncRunRecord,
  SyncState,
  SyncRunStatus,
  SyncRunStats,
} from "../domain/types";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface RepoFilter {
  eventId?: string;
  enabled?: boolean;
}

export interface RepoStore {
  create(repo: GithubRepoConfig): Promise<void>;
  get(id: string): Promise<GithubRepoConfig | null>;
  getByOwnerRepo(owner: string, repo: string): Promise<GithubRepoConfig | null>;
  list(filter: RepoFilter, cursor: string | null, limit: number): Promise<Page<GithubRepoConfig>>;
  update(id: string, patch: Partial<GithubRepoConfig>): Promise<GithubRepoConfig | null>;
  delete(id: string): Promise<boolean>;
}

export interface LinkFilter {
  taskId?: string;
  owner?: string;
  repo?: string;
  issueNumber?: number;
  repoId?: string;
  syncState?: SyncState[];
}

export interface LinkStore {
  create(link: LinkRecord): Promise<void>;
  getById(id: string): Promise<LinkRecord | null>;
  getByTaskId(taskId: string): Promise<LinkRecord | null>;
  getByIssue(repoId: string, issueNumber: number): Promise<LinkRecord | null>;
  list(filter: LinkFilter, cursor: string | null, limit: number): Promise<Page<LinkRecord>>;
  update(id: string, patch: Partial<LinkRecord>): Promise<LinkRecord | null>;
  delete(id: string): Promise<boolean>;
}

export interface RunStore {
  create(run: SyncRunRecord): Promise<void>;
  get(id: string): Promise<SyncRunRecord | null>;
  list(cursor: string | null, limit: number): Promise<Page<SyncRunRecord>>;
  update(
    id: string,
    patch: Partial<Pick<SyncRunRecord, "status" | "stats" | "startedAt" | "finishedAt" | "error">>,
  ): Promise<void>;
  hasActive(scopeKey: string): Promise<boolean>;
}

// @dub/events IdempotencyStore-compatible (wasProcessed / markProcessed).
export interface ProcessedEventStore {
  wasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
  purgeOlderThan(iso: string): Promise<number>;
}

export interface Stores {
  repos: RepoStore;
  links: LinkStore;
  runs: RunStore;
  processed: ProcessedEventStore;
}

export type { SyncRunStatus, SyncRunStats };
