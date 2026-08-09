// GitHub API port. P0b: the concrete REST/GraphQL client (App installation auth,
// 8-N1) is a later integration wave, so production ships a stub that fails closed
// and unit tests inject a mock. The engine depends only on this interface.
import { DubError } from "@dub/errors";
import type { IssueSnapshot } from "../domain/types";

export interface CreateIssueInput {
  owner: string;
  repo: string;
  title: string;
  body: string | null;
  labels: string[];
  assignees: string[];
}

export interface UpdateIssueInput {
  owner: string;
  repo: string;
  number: number;
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
}

export interface GithubApiClient {
  getIssue(owner: string, repo: string, number: number): Promise<IssueSnapshot | null>;
  createIssue(input: CreateIssueInput): Promise<IssueSnapshot>;
  updateIssue(input: UpdateIssueInput): Promise<IssueSnapshot>;
  addComment(owner: string, repo: string, number: number, body: string): Promise<void>;
  // Reconciliation: issues updated since `sinceIso` (null = full).
  listIssues(owner: string, repo: string, sinceIso: string | null): Promise<IssueSnapshot[]>;
}

// Fail-closed stub used until the GitHub App integration wave lands.
export class StubGithubApi implements GithubApiClient {
  private fail(op: string): never {
    throw new DubError("GITHUB_NOT_CONFIGURED", `GitHub API not wired yet (${op}); pending 8-N1 App auth`, {
      status: 502,
      retryable: false,
    });
  }
  getIssue(): Promise<IssueSnapshot | null> {
    return this.fail("getIssue");
  }
  createIssue(): Promise<IssueSnapshot> {
    return this.fail("createIssue");
  }
  updateIssue(): Promise<IssueSnapshot> {
    return this.fail("updateIssue");
  }
  addComment(): Promise<void> {
    return this.fail("addComment");
  }
  listIssues(): Promise<IssueSnapshot[]> {
    return this.fail("listIssues");
  }
}
