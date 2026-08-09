// identity-roster port for user lookups (githubLogin mapping, frozen B4).
// Authz (/authz/check) is handled by @dub/auth-client, not here.
import type { RequestContext, ServiceClient } from "@dub/http";
import type { identity } from "@dub/types";

export interface IdentityUserClient {
  // Returns null when the user has no githubLogin (assignee mapping is skipped).
  githubLoginOf(ctx: RequestContext, userId: string): Promise<string | null>;
  userIdByGithubLogin(ctx: RequestContext, login: string): Promise<string | null>;
}

export class HttpIdentityClient implements IdentityUserClient {
  constructor(private readonly client: ServiceClient) {}
  async githubLoginOf(ctx: RequestContext, userId: string): Promise<string | null> {
    const user = await this.client.get<identity.IdentityUser>(ctx, `/users/${encodeURIComponent(userId)}`);
    return user.githubLogin ?? null;
  }
  async userIdByGithubLogin(ctx: RequestContext, login: string): Promise<string | null> {
    const page = await this.client.get<{ items: identity.IdentityUser[] }>(ctx, `/users`, {
      query: { githubLogin: login, limit: 1 },
    });
    const hit = page.items.find((u) => (u.githubLogin ?? "").toLowerCase() === login.toLowerCase());
    return hit?.id ?? null;
  }
}
