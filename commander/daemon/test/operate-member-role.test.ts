// メンバー管理 / ロール writes against a fake api-gateway that mimics member-service and
// identity-roster: each write previews, executes and is read back (done), a write the
// service drops is reported as unverified, and protected owner/bot ids are blocked.
import { OperateExecutor } from "../src/operate/executor.ts";
import { GatewayClient } from "../src/operate/gateway.ts";
import { parsePlan } from "../src/operate/plan.ts";

const BOT = "user_bot";
const BOT_ROLE = "role_bot";

/** `drop` = the service answers 2xx but does not persist (or, for a revoke, keeps the row). */
function fakeGateway(opts: { drop?: boolean } = {}) {
  const teams = [{ id: "team_a", key: "dev", name: "開発", color: null as string | null, description: null as string | null, sortOrder: 1000 }];
  const members: Record<string, unknown>[] = [
    { id: "mem_1", name: "山田 太郎", status: "added", teamIds: ["team_a"], identityUserId: null, roleTitle: null, lastName: "山田", firstName: "太郎", grade: "3", version: 4 },
  ];
  const users: Record<string, unknown>[] = [
    { id: "user_1", email: "a@developershub.jp", displayName: "A", furigana: null, githubLogin: null, status: "active", roleIds: [] },
    { id: BOT, email: "bot@developershub.jp", displayName: "bot", furigana: null, githubLogin: null, status: "active", roleIds: [BOT_ROLE] },
  ];
  const roles: Record<string, unknown>[] = [
    { id: "role_sys_admin", name: "admin", permissions: ["identity:admin"], isSystem: true },
    { id: "role_x", name: "広報", permissions: ["app:events:view"], isSystem: false },
  ];
  const assignments = [{ id: "ra_1", userId: "user_1", roleId: "role_x", roleName: "広報", resourceType: null, resourceId: null }];
  let seq = 0;
  const calls: string[] = [];

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, data: unknown) => new Response(status === 204 ? null : JSON.stringify(data), { status });
    const keep = (fn: () => void) => void (opts.drop || fn());
    let m: RegExpMatchArray | null;

    if (path === "/members/teams" && method === "GET") return reply(200, { teams });
    if ((m = path.match(/^\/members\/teams\/([^/]+)$/)) && method === "PATCH") {
      const t = teams.find((x) => x.id === m![1]);
      if (!t) return reply(404, {});
      keep(() => Object.assign(t, body, body.key ? { key: String(body.key).toLowerCase() } : {}));
      return reply(200, t);
    }
    if (path === "/members/overview") return reply(200, { teams, members });
    if (path === "/members/people" && method === "POST") {
      const row = { id: `mem_n${++seq}`, identityUserId: null, version: 1, ...body, teamIds: [...new Set(body.teamIds as string[])].reverse() };
      keep(() => members.push(row));
      return reply(201, row);
    }
    if ((m = path.match(/^\/members\/people\/([^/]+)(\/identity-link)?$/))) {
      const p = members.find((x) => x.id === m![1]);
      if (!p) return reply(404, {});
      if (body.version !== p.version) return reply(409, { error: { code: "MEMBER_VERSION_CONFLICT" } });
      const { version: _v, ...rest } = body;
      keep(() => Object.assign(p, rest, { version: (p.version as number) + 1 }));
      return reply(200, p);
    }

    if (path === "/identity/users/invite") {
      const u = { id: `user_n${++seq}`, email: String(body.email).toLowerCase(), displayName: body.displayName ?? "x", furigana: body.furigana ?? null, githubLogin: null, status: "invited", roleIds: [] };
      keep(() => users.push(u));
      return reply(201, { user: u });
    }
    if ((m = path.match(/^\/identity\/users\/([^/]+)$/))) {
      const u = users.find((x) => x.id === m![1]);
      if (!u) return reply(404, {});
      if (method === "PATCH") keep(() => Object.assign(u, body));
      return reply(200, u);
    }
    if (path === "/identity/roles" && method === "GET") return reply(200, { items: roles, nextCursor: null });
    if (path === "/identity/roles" && method === "POST") {
      // The service dedupes and sorts permission keys.
      const r = { id: `role_n${++seq}`, name: body.name, permissions: [...new Set(body.permissions as string[])].sort(), isSystem: false };
      keep(() => roles.push(r));
      return reply(201, r);
    }
    if ((m = path.match(/^\/identity\/roles\/([^/]+)$/)) && method === "PATCH") {
      const r = roles.find((x) => x.id === m![1]);
      if (!r) return reply(404, {});
      keep(() => Object.assign(r, body, body.permissions ? { permissions: [...body.permissions].sort() } : {}));
      return reply(200, r);
    }
    if ((m = path.match(/^\/identity\/users\/([^/]+)\/roles$/))) {
      if (method === "GET") return reply(200, assignments.filter((a) => a.userId === m![1]));
      const a = { id: `ra_n${++seq}`, userId: m[1]!, roleId: body.roleId, roleName: "", resourceType: body.resourceType ?? null, resourceId: body.resourceId ?? null };
      keep(() => assignments.push(a));
      return reply(201, a);
    }
    if ((m = path.match(/^\/identity\/users\/([^/]+)\/roles\/([^/]+)$/)) && method === "DELETE") {
      const i = assignments.findIndex((a) => a.id === m![2] && a.userId === m![1]);
      if (i < 0) return reply(404, {});
      keep(() => assignments.splice(i, 1));
      return reply(204, null);
    }
    return reply(404, { error: { code: "no_route" } });
  }) as typeof fetch;
  return { fetchImpl, calls, teams, members, users, roles, assignments };
}

function setup(opts: { drop?: boolean } = {}) {
  const gw = fakeGateway(opts);
  const exec = new OperateExecutor(
    new GatewayClient({ baseUrl: "https://dub-api-gateway-staging.example.dev", token: "t" }, gw.fetchImpl),
    { append() {} },
    Date.now,
    { roles: ["role_sys_admin", BOT_ROLE], users: [BOT] },
  );
  return { gw, exec };
}

async function run(exec: OperateExecutor, steps: unknown[]) {
  const p = parsePlan({ summary: "", steps });
  if (!p.ok) throw new Error(p.errors.join());
  const preview = await exec.preview(p.plan);
  return { preview, result: preview.blockers.length ? null : await exec.execute(preview.previewId) };
}

const CASES: [string, unknown[]][] = [
  ["members.teams.update", [{ id: "t", op: "members.teams.update", params: { id: "team_a" }, body: { name: "開発班", key: "DEV", color: "#336699", description: "アプリ開発" } }]],
  [
    "members.people.create",
    [{ id: "c", op: "members.people.create", body: { status: "invited", teamIds: ["team_a"], lastName: "佐藤", firstName: "花子", grade: "1", note: "紹介" } }],
  ],
  [
    "members.people.update",
    [
      { id: "ov", op: "members.overview" },
      {
        id: "u",
        op: "members.people.update",
        forEach: "{{ov.members}}",
        where: [{ field: "id", op: "eq", value: "mem_1" }],
        params: { id: "{{item.id}}" },
        body: { version: "{{item.version}}", status: "on_leave", teamIds: [], roleTitle: "リーダー" },
      },
    ],
  ],
  [
    "members.people.linkIdentity",
    [
      { id: "ov", op: "members.overview" },
      { id: "l", op: "members.people.linkIdentity", params: { id: "mem_1" }, body: { identityUserId: "user_1", version: "{{ov.members[0].version}}" } },
    ],
  ],
  ["users.invite", [{ id: "i", op: "users.invite", body: { email: "New@Example.com", displayName: "新人", furigana: "しんじん" } }]],
  ["users.update", [{ id: "u", op: "users.update", params: { id: "user_1" }, body: { displayName: "A さん", status: "disabled" } }]],
  ["roles.create", [{ id: "r", op: "roles.create", body: { name: "記録係", permissions: ["event:read", "app:events:view", "event:read"] } }]],
  ["roles.update", [{ id: "r", op: "roles.update", params: { id: "role_x" }, body: { name: "広報班", permissions: ["event:read", "app:events:view"] } }]],
  ["roles.assign", [{ id: "a", op: "roles.assign", params: { id: "user_1" }, body: { roleId: "role_x" } }]],
  ["roles.revoke", [{ id: "d", op: "roles.revoke", params: { id: "user_1", assignmentId: "ra_1" } }]],
];

describe("メンバー管理 / ロール writes", () => {
  it.each(CASES)("%s previews, executes and reads back", async (_id, steps) => {
    const { exec } = setup();
    const { preview, result } = await run(exec, steps);
    expect(preview.blockers).toEqual([]);
    expect(result).toMatchObject({ verdict: "done", results: [{ outcome: "ok" }] });
  });

  it.each(CASES)("%s is unverified when the service drops the write", async (_id, steps) => {
    const { exec } = setup({ drop: true });
    const { result } = await run(exec, steps);
    expect(result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
  });

  it("puts permission grants and revokes behind the confirmation phrase, member edits not", async () => {
    for (const [id, steps] of CASES) {
      const { preview } = await run(setup().exec, steps);
      expect(preview.requiresPhrase, id).toBe(["roles.update", "roles.assign", "roles.revoke"].includes(id));
    }
  });

  it("never sends roleIds with an invite (granting goes through roles.assign)", () => {
    const p = parsePlan({ summary: "", steps: [{ id: "i", op: "users.invite", body: { email: "x@example.com", roleIds: ["role_x"] } }] });
    expect(p).toEqual({ ok: false, errors: ["手順1: 本文の「roleIds」は変更できません"] });
  });

  it.each([
    ["editing a protected role", { id: "r", op: "roles.update", params: { id: BOT_ROLE }, body: { permissions: ["identity:admin"] } }, "オーナーと Commander ボット自身のロールは変更・付与できません"],
    ["granting a protected role", { id: "a", op: "roles.assign", params: { id: "user_1" }, body: { roleId: "role_sys_admin" } }, "オーナーと Commander ボット自身のロールは変更・付与できません"],
    ["granting the bot a role", { id: "a", op: "roles.assign", params: { id: BOT }, body: { roleId: "role_x" } }, "オーナーと Commander ボット自身のロールは付け外しできません"],
    ["revoking from the bot", { id: "d", op: "roles.revoke", params: { id: BOT, assignmentId: "ra_9" } }, "オーナーと Commander ボット自身のロールは付け外しできません"],
    ["disabling the bot account", { id: "u", op: "users.update", params: { id: BOT }, body: { status: "disabled" } }, "オーナーと Commander ボット自身のアカウントは変更できません"],
  ])("blocks %s before approval", async (_name, step, reason) => {
    const { exec, gw } = setup();
    const { preview, result } = await run(exec, [step]);
    expect(preview.blockers).toEqual([`手順1: ${reason}`]);
    expect(result).toBeNull();
    expect(gw.calls).toEqual([]);
  });
});
